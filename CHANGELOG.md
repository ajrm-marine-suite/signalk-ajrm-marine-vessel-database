# Changelog

## 0.7.2

- Classify exact ITU `111MIDXXX` identities as SAR aircraft and show the
  category and collision-candidate status in the database.
- Recognize the optional fixed-wing/helicopter subtype digit and exclude SAR
  aircraft from the ITU ship-station lookup queue.

## 0.7.1

- Add confirmed deletion of the currently selected vessel by exact MMSI.
- Add one-button removal of the AJRM Marine Console BITE vessels using the
  explicit reserved test MMSI list rather than vessel-name matching.
- Prevent selected and BITE vessel deletion while an online lookup is active.

## 0.7.0

- Add editable JSON export for backup and manual vessel-data maintenance.
- Add validated merge and replace imports, with an automatic server-side backup
  before replacement and atomic rejection of invalid files.
- Add a cancellable, rate-limited background lookup for every vessel missing a
  name or callsign using the official ITU MARS register.
- Preserve existing identity values and store only explicit ITU fields without
  guessing IMO numbers or AIS ship types.
- Show ITU lookup provenance, progress and returned registration details in the
  web app.

## 0.6.1

- Publish IMO registration numbers as canonical Signal K static vessel data
  rather than dynamic value leaves.
- Check the current Signal K vessel model before filling persisted fields, so
  ordinary dynamic AIS updates do not trigger repeated static-data rewrites.
- Preserve other vessel registrations when filling a missing IMO number.

## 0.5.2

- Exclude test fixtures from the published package contents.

## 0.5.1

- Add Signal K AppStore AIS category metadata.

## 0.5.0

- Initial public beta release as AJRM Marine Vessel Database.
