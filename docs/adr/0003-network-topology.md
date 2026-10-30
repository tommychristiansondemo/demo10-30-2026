# ADR-0003: VPC with private subnets in prod; no VPC in dev

**Context.** Enterprise reviewers expect compute in private subnets. But GridSight Lambdas only call AWS service APIs and Bedrock, and a NAT gateway costs about $33/month before data.

**Decision.** `prod` runs every application Lambda in private subnets (two AZs) with one NAT gateway for egress, free S3 and DynamoDB gateway endpoints (so lake and table traffic bypasses the NAT), VPC flow logs for rejected traffic, and an egress-only security group. `dev` runs Lambdas without a VPC. The mode is a config switch (`network.mode`).

**Consequences.**
- Prod gets network-level controls and a place to attach future private integrations (EMS/historian over Direct Connect or VPN).
- One NAT gateway is a single-AZ dependency for egress. For higher availability set `natGateways: 2`.
- Interface endpoints (Athena, Bedrock, SSM, Secrets Manager, Cognito, Lambda, Logs) could replace the NAT entirely, at about $7–15/month each across two AZs. That pays off when there are compliance requirements for no internet egress; it isn't the default.
- AZs are pinned in config so `cdk synth` needs no EC2 lookups.
