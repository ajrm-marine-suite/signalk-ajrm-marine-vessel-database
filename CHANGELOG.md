# Changelog

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
