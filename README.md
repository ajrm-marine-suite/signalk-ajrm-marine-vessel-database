# AJRM Marine Vessel Database

AJRM Marine Vessel Database is a Signal K plugin that gradually learns static AIS vessel details by MMSI.

Version `0.7.0` adds editable JSON export/import and a rate-limited background
lookup for vessels with a missing name or callsign using the official ITU MARS
ship-station register.

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
- Export every vessel to an editable JSON backup
- Import an edited backup by merging records or replacing the database
- Look up every vessel with a missing name or callsign in ITU MARS
- Click a vessel row to show stored static details
- Delete all, for clearing debug or replay data

## Export and Import

**Export** downloads a human-readable JSON file containing all stored vessels,
timestamps, field provenance and online-lookup evidence. It can be retained as a
backup or edited in a text editor.

**Import** validates the complete file before applying anything:

- **Merge import** updates records included in the file and preserves all other
  vessels and fields. Set an editable field to `null` to clear it.
- **Replace database** restores exactly the vessels in the file. Before replacing
  anything, the plugin writes a timestamped `vessels.before-import-*.json` backup
  beside the live database on the Pi.

Invalid MMSIs, duplicate MMSIs, invalid values, mistyped/unknown field names and
invalid timestamps reject the whole import without partially changing the live
database.

## Online MMSI Lookup

**Look up unknown** selects every stored vessel lacking a name or callsign and
queries the [ITU Maritime mobile Access and Retrieval System
(MARS)](https://www.itu.int/en/itu-r/terrestrial/mars/pages/default.aspx) by MMSI.
The job runs on the Signal K server, continues if the browser is closed, shows
progress when the page is open, and can be cancelled.

Queries are sequential with a one-second interval. Existing name, callsign and
IMO values are never overwritten. The plugin stores only explicit returned data,
including ITU administration and classification fields. It does not guess that a
generic vessel-identification number is an IMO number and does not translate ITU
classification codes into AIS ship types. Internet access is required, and a
missing result is not treated as an error because flag administrations may not
have notified every vessel to ITU.

## Filling Missing Data

When **Fill missing static data** is enabled, AJRM Marine Vessel Database watches every non-self vessel delta. If a known MMSI is seen and the current Signal K context has not provided a static field that exists in the database, the plugin publishes that field back into the same vessel context.

Only static details are filled. Live navigation data such as position, speed, course, heading, CPA, TCPA, and alert state are never filled from the database.

## Install

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-vessel-database.git#v0.7.0 --omit=dev --no-package-lock
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
## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You may use, study, share, and modify it under that licence. If you modify it and make it available to users over a network, the corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want different terms.
