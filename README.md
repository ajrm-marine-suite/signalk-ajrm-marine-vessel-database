# AJRM Marine Vessel Database

AJRM Marine Vessel Database is a Signal K plugin that gradually learns static AIS vessel details by MMSI.

AIS targets, especially Class B targets, do not broadcast static data such as name, callsign, dimensions, or vessel type as often as position data. This plugin watches normal Signal K deltas, stores the static details when they appear, and can publish known static details back into Signal K when a known MMSI is later seen without them.

The primary key is MMSI. The database is a JSON file on disk, stored by default at `~/.signalk/plugin-config-data/vessel-database/vessels.json`, so it survives Signal K restarts and Pi reboots.

## What It Stores

- Vessel name
- Callsign
- IMO number when present
- AIS class
- AIS ship type
- Length, beam, draft
- AIS dimensions to bow, stern, port, and starboard when they arrive from AIS-specific ship-dimension data
- First seen, last seen, and per-field update timestamps

## Web App

Open **AJRM Marine Vessel Database** from the Signal K web apps list. The page shows learned vessels and includes:

- Search/filter
- Refresh
- Click a vessel row to show stored static details
- Delete all, for clearing debug or replay data

## Filling Missing Data

When **Fill missing static data** is enabled, AJRM Marine Vessel Database watches every non-self vessel delta. If a known MMSI is seen and the current Signal K context has not provided a static field that exists in the database, the plugin publishes that field back into the same vessel context.

Only static details are filled. Live navigation data such as position, speed, course, heading, CPA, TCPA, and alert state are never filled from the database.

## Install

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-vessel-database.git#v0.5.2 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

## Settings

- **Database directory**: directory used for the persistent `vessels.json` file. The default is `~/.signalk/plugin-config-data/vessel-database`.
- **Fill missing static data**: when enabled, known fields are published back into the vessel's Signal K context if a target is seen without those static fields.
- **Learn own vessel**: off by default, so `vessels.self` is not added to the AIS vessel database.
- **Publish summary**: publishes plugin status to `vessels.self.plugins.ajrmMarineVesselDatabase.summary`.
- **Fill cooldown seconds**: rate limit for republishing any one field into any one vessel context.

## Tests

```bash
npm test
```

The test command syntax-checks the plugin and browser JavaScript.

## Safety Note

This plugin only stores and republishes non-changing/static vessel details. It does not alter live navigation fields such as position, SOG, COG, heading, CPA, TCPA, or alert state.

AJRM Marine Vessel Database ignores generic `design.dimensions` reference offsets, including when they arrive inside full vessel snapshot updates, because those can be assumed hull geometry from another plugin rather than AIS static data. Older stored reference offsets are scrubbed on startup so stale assumed dimensions are not shown or republished.


## Public Beta

Local vessel notes and identity database for AJRM Marine Suite.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
