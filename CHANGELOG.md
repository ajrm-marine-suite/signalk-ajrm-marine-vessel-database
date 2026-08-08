# Changelog

## 0.8.2

- Add concise purpose headers to every maintained runtime module so its role is
  clear before reading implementation details.
- Add a regression check that prevents new source modules from being introduced
  without a module-purpose header.
- Align OpenAPI metadata with the package release and test that the versions do
  not drift apart again.
- Preserve existing runtime contracts and behaviour following a suite-wide
  maintainability and Signal K integration review.

## 0.8.1

- Include the Simulator's two reserved default AIS base-station MMSIs in
  **Delete test vessels**.
- Keep cleanup identity-based so real AIS base stations and similarly named
  records remain untouched.

## 0.7.4

- Correct the current release and installation version in the public guide.

## 0.7.3

- Extend the exact-identity test cleanup to remove Simulator targets as well as
  Console BITE targets, including the synthetic SAR aircraft.
- Rename the web action to **Delete test vessels** and retain the existing API
  endpoint for compatibility.
- Use only the reserved synthetic SAR MMSI in tests.

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
