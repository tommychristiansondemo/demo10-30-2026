"""Quick start: python example.py (set GRIDSIGHT_API, GRIDSIGHT_CLIENT_ID, GRIDSIGHT_USERNAME, GRIDSIGHT_PASSWORD)."""
import os

from gridsight import GridSight

gs = GridSight.login(os.environ["GRIDSIGHT_API"], client_id=os.environ["GRIDSIGHT_CLIENT_ID"],
                     username=os.environ["GRIDSIGHT_USERNAME"], password=os.environ["GRIDSIGHT_PASSWORD"])
now = gs.current()
print(f"Load {now['load_mw']:,.0f} MW | PRC {now['reserves']['prc_mw']:,.0f} MW | status {now['derived']['reserve_status']}")
for a in gs.alerts()[:5]:
    print(f"[{a['severity']}] {a['title']}")
print(gs.ask("Give me a three-bullet shift handover summary.")["answer"])
