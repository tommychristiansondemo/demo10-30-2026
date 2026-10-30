import { CfnOutput, Duration, Lazy, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../../config/environments';
import { ServiceFunction } from '../constructs/service-function';

export interface AuthStackProps extends StackProps {
  config: EnvironmentConfig;
  lakeBucket: s3.IBucket;
  athenaResultsBucket: s3.IBucket;
  glueDatabaseName: string;
  workgroupName: string;
}

export const ROLE_GROUPS = [
  { name: 'Admin', precedence: 0, description: 'Full access including configuration, audit log and user management' },
  { name: 'Operator', precedence: 1, description: 'Analyst + acknowledge/resolve and create alerts' },
  { name: 'Analyst', precedence: 2, description: 'Viewer + AI assistant, forecasts, SQL and knowledge search' },
  { name: 'Viewer', precedence: 3, description: 'Read-only dashboards and alerts' },
] as const;

/**
 * Identity: Cognito user pool (username/password self-registration with a chosen role, optional
 * MFA, optional SAML/OIDC federation),
 * role groups, app clients for the SPA and CLI/SDK, and an identity pool that maps groups to
 * IAM roles (Analyst+ get read access to the data lake for notebooks).
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly cliClient: cognito.UserPoolClient;
  readonly identityPoolId: string;
  readonly cognitoDomain: string;
  readonly federatedProviders: string[] = [];

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const fnDefaults = { logRetentionDays: config.observability.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY };

    const preSignUp = new ServiceFunction(this, 'PreSignUp', {
      ...fnDefaults,
      entry: 'cognito-triggers.ts',
      handler: 'preSignUp',
      description: 'Validate the requested role and auto-confirm self sign-ups (no email verification)',
      environment: { ALLOWED_EMAIL_DOMAINS: config.auth.allowedEmailDomains.join(',') },
    });
    const postConfirmation = new ServiceFunction(this, 'PostConfirmation', {
      ...fnDefaults,
      entry: 'cognito-triggers.ts',
      handler: 'postConfirmation',
      description: 'Add newly confirmed users to the role group they chose at sign-up',
      environment: { DEFAULT_GROUP: 'Viewer' },
    });
    const preTokenGeneration = new ServiceFunction(this, 'PreTokenGeneration', {
      ...fnDefaults,
      entry: 'cognito-triggers.ts',
      handler: 'preTokenGeneration',
      description: 'Add email to access tokens; assign the sign-up role if the user has no group yet',
      environment: { DEFAULT_GROUP: 'Viewer' },
    });
    // Scoped to user pools in this account/region; referencing the pool ARN directly would create a cycle.
    for (const fn of [postConfirmation, preTokenGeneration]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminAddUserToGroup'],
          resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
        }),
      );
    }

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `gridsight-${config.envName}`,
      selfSignUpEnabled: config.auth.selfSignUp,
      // Classroom-friendly: plain usernames, no email, no verification codes, 6-character passwords.
      signInAliases: { username: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: false, mutable: true }, fullname: { required: false, mutable: true } },
      customAttributes: { role: new cognito.StringAttribute({ minLen: 1, maxLen: 16, mutable: true }) },
      passwordPolicy: { minLength: 6, requireDigits: false, requireLowercase: false, requireUppercase: false, requireSymbols: false },
      mfa: cognito.Mfa[config.auth.mfa],
      ...(config.auth.mfa === 'OFF' ? {} : { mfaSecondFactor: { otp: true, sms: false } }),
      accountRecovery: cognito.AccountRecovery.NONE,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: config.retainData,
      removalPolicy,
      lambdaTriggers: { preSignUp, postConfirmation },
    });

    // V2 trigger event so the access token (not just the ID token) can be customized.
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preTokenGeneration, cognito.LambdaVersion.V2_0);

    // ---- Role groups (+ IAM roles for the identity pool) -------------------------------------
    // The identity pool is created after the clients below; resolve its id lazily at synth time.
    const identityPoolRef = { id: '' };
    const identityPoolIdToken = Lazy.string({ produce: () => identityPoolRef.id });
    const federatedPrincipal = () =>
      new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPoolIdToken },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      );

    const lakeReaderStatements = [
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [props.lakeBucket.arnForObjects('curated/*')] }),
      new iam.PolicyStatement({ actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [props.lakeBucket.bucketArn] }),
      new iam.PolicyStatement({
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup'],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${props.workgroupName}`],
      }),
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartitions'],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${props.glueDatabaseName}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${props.glueDatabaseName}/*`,
        ],
      }),
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'],
        resources: [props.athenaResultsBucket.bucketArn, props.athenaResultsBucket.arnForObjects('athena/*')],
      }),
    ];

    const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: federatedPrincipal(),
      description: 'GridSight default authenticated identity (Viewer): no AWS permissions',
    });

    const groupRoles: Record<string, iam.Role> = {};
    for (const g of ROLE_GROUPS) {
      let roleArn: string | undefined;
      if (g.name !== 'Viewer') {
        const role = new iam.Role(this, `${g.name}IdentityRole`, {
          assumedBy: federatedPrincipal(),
          description: `GridSight ${g.name}: read-only access to the data lake via Athena`,
          maxSessionDuration: Duration.hours(1),
        });
        lakeReaderStatements.forEach((s) => role.addToPolicy(s));
        groupRoles[g.name] = role;
        roleArn = role.roleArn;
      }
      new cognito.CfnUserPoolGroup(this, `Group${g.name}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: g.name,
        description: g.description,
        precedence: g.precedence,
        roleArn,
      });
    }

    // ---- Federation (optional; ready for a corporate IdP) ------------------------------------
    const providers: cognito.UserPoolClientIdentityProvider[] = [cognito.UserPoolClientIdentityProvider.COGNITO];
    const providerConstructs: Construct[] = [];
    if (config.auth.federation?.saml) {
      const saml = new cognito.UserPoolIdentityProviderSaml(this, 'Saml', {
        userPool: this.userPool,
        name: config.auth.federation.saml.name,
        metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(config.auth.federation.saml.metadataUrl),
        attributeMapping: {
          email: cognito.ProviderAttribute.other('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'),
          fullname: cognito.ProviderAttribute.other('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'),
        },
      });
      providers.push(cognito.UserPoolClientIdentityProvider.custom(config.auth.federation.saml.name));
      providerConstructs.push(saml);
      this.federatedProviders.push(config.auth.federation.saml.name);
    }
    if (config.auth.federation?.oidc) {
      const o = config.auth.federation.oidc;
      const oidc = new cognito.UserPoolIdentityProviderOidc(this, 'Oidc', {
        userPool: this.userPool,
        name: o.name,
        clientId: o.clientId,
        clientSecret: SecretValue.secretsManager(o.clientSecretName).unsafeUnwrap(),
        issuerUrl: o.issuerUrl,
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: { email: cognito.ProviderAttribute.other('email'), fullname: cognito.ProviderAttribute.other('name') },
      });
      providers.push(cognito.UserPoolClientIdentityProvider.custom(o.name));
      providerConstructs.push(oidc);
      this.federatedProviders.push(o.name);
    }

    // ---- App clients ----------------------------------------------------------------------
    const appUrl = `https://${config.domain.appHost}/`;
    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'gridsight-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: providers,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [appUrl, 'http://localhost:5173/'],
        logoutUrls: [appUrl, 'http://localhost:5173/'],
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(config.envName === 'prod' ? 1 : 7),
      enableTokenRevocation: true,
    });
    providerConstructs.forEach((p) => this.webClient.node.addDependency(p));

    // For scripts, notebooks and the SDKs: USER_PASSWORD_AUTH lets `aws cognito-idp initiate-auth` mint tokens.
    this.cliClient = this.userPool.addClient('CliClient', {
      userPoolClientName: 'gridsight-cli',
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
    });

    const domainPrefix = `gridsight-${config.envName}-${this.account}`;
    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });
    this.cognitoDomain = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    // ---- Identity pool with token-based (group) role mapping ---------------------------------
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `gridsight_${config.envName}`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        { clientId: this.webClient.userPoolClientId, providerName: this.userPool.userPoolProviderName, serverSideTokenCheck: true },
        { clientId: this.cliClient.userPoolClientId, providerName: this.userPool.userPoolProviderName, serverSideTokenCheck: true },
      ],
    });
    identityPoolRef.id = identityPool.ref;
    this.identityPoolId = identityPool.ref;
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
      roleMappings: Object.fromEntries(
        [this.webClient, this.cliClient].map((c, i) => [
          `client${i}`,
          { type: 'Token', ambiguousRoleResolution: 'AuthenticatedRole', identityProvider: `${this.userPool.userPoolProviderName}:${c.userPoolClientId}` },
        ]),
      ),
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'WebClientId', { value: this.webClient.userPoolClientId });
    new CfnOutput(this, 'CliClientId', { value: this.cliClient.userPoolClientId });
    new CfnOutput(this, 'IdentityPoolId', { value: this.identityPoolId });
    new CfnOutput(this, 'HostedUiDomain', { value: domain.baseUrl() });
    new CfnOutput(this, 'SamlEntityId', { value: `urn:amazon:cognito:sp:${this.userPool.userPoolId}`, description: 'Use as the SAML audience / entity ID in your IdP' });
    new CfnOutput(this, 'SamlAcsUrl', { value: `https://${this.cognitoDomain}/saml2/idpresponse`, description: 'Assertion Consumer Service URL for your IdP' });
  }
}
