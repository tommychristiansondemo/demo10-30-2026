"""GridSight AI Python client.

    from gridsight import GridSight
    gs = GridSight.login("https://api.dev.gridsight.awsteach.com", client_id="...", username="...", password="...")
    print(gs.current()["load_mw"])
    df = gs.sql_df("SELECT dt, max(load_mw) AS peak FROM grid_interval WHERE dt >= '2026-10-01' GROUP BY dt")
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import requests

__all__ = ["GridSight", "GridSightError"]
__version__ = "1.0.0"


class GridSightError(Exception):
    def __init__(self, status: int, code: str, message: str, request_id: str | None = None):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.request_id = status, code, request_id


@dataclass
class GridSight:
    base_url: str
    token: str
    timeout: float = 60.0
    session: requests.Session = field(default_factory=requests.Session)

    @classmethod
    def login(cls, base_url: str, *, client_id: str, username: str, password: str, region: str = "us-east-1") -> "GridSight":
        """Authenticate with USER_PASSWORD_AUTH against the GridSight CLI app client."""
        res = requests.post(
            f"https://cognito-idp.{region}.amazonaws.com/",
            headers={"content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth"},
            json={"AuthFlow": "USER_PASSWORD_AUTH", "ClientId": client_id, "AuthParameters": {"USERNAME": username, "PASSWORD": password}},
            timeout=30,
        )
        body = res.json()
        if not res.ok:
            raise GridSightError(res.status_code, body.get("__type", "auth_error"), body.get("message", "Authentication failed"))
        if "ChallengeName" in body:
            raise GridSightError(400, body["ChallengeName"], "Complete the sign-in challenge in the web app first")
        return cls(base_url.rstrip("/"), body["AuthenticationResult"]["AccessToken"])

    # -- transport -----------------------------------------------------------------
    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        res = self.session.request(
            method, f"{self.base_url}{path}", json=body, timeout=self.timeout,
            headers={"authorization": f"Bearer {self.token}"},
        )
        data = res.json() if res.content else None
        if not res.ok:
            err = (data or {}).get("error", {})
            raise GridSightError(res.status_code, err.get("code", "http_error"), err.get("message", res.reason), err.get("requestId"))
        return data

    # -- grid ------------------------------------------------------------------------
    def current(self) -> dict:
        return self._req("GET", "/v1/grid/current")

    def series(self, start: str | None = None, end: str | None = None, resolution: str | None = None) -> list[dict]:
        q = "&".join(f"{k}={quote(v)}" for k, v in (("start", start), ("end", end), ("resolution", resolution)) if v)
        return self._req("GET", f"/v1/grid/series?{q}")["points"]

    def forecast(self, hours: int = 48) -> dict:
        return self._req("GET", f"/v1/forecast/load?hours={hours}")

    def anomalies(self, hours: int = 24) -> list[dict]:
        return self._req("GET", f"/v1/anomalies?hours={hours}")["anomalies"]

    # -- alerts ------------------------------------------------------------------------
    def alerts(self, status: str = "OPEN", limit: int = 100) -> list[dict]:
        return self._req("GET", f"/v1/alerts?status={status}&limit={limit}")["alerts"]

    def acknowledge(self, alert_id: str, note: str | None = None) -> dict:
        return self._req("POST", f"/v1/alerts/{quote(alert_id, safe='')}/ack", {"note": note})

    def resolve(self, alert_id: str, note: str | None = None) -> dict:
        return self._req("POST", f"/v1/alerts/{quote(alert_id, safe='')}/resolve", {"note": note})

    # -- query & AI ------------------------------------------------------------------------
    def sql(self, sql: str, max_rows: int = 1000) -> dict:
        return self._req("POST", "/v1/query/sql", {"sql": sql, "maxRows": max_rows})

    def sql_df(self, sql: str, max_rows: int = 10000):
        """Run SQL and return a pandas DataFrame (requires pandas)."""
        import pandas as pd

        r = self.sql(sql, max_rows)
        return pd.DataFrame(r["rows"], columns=[c["name"] for c in r["columns"]])

    def ask(self, message: str, session_id: str | None = None) -> dict:
        return self._req("POST", "/v1/ai/ask", {"message": message, "sessionId": session_id})

    def nl_sql(self, question: str, execute: bool = True) -> dict:
        return self._req("POST", "/v1/ai/sql", {"question": question, "execute": execute})
