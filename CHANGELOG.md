# Changelog

Changes of `homebridge-tydom-mk`, the fork of
[mgcrea/homebridge-tydom](https://github.com/mgcrea/homebridge-tydom). The
history of the versions before the fork is in the
[upstream changelog](https://github.com/mgcrea/homebridge-tydom/blob/main/CHANGELOG.md).

## Unreleased

- The startup log is readable. It used to print four lines per accessory
  ("Found new device", "Adding new device", "Found new tydom device", "Updating
  accessory"), including the HomeKit UUID and a warning for every device type
  the plugin does not support. It now prints the device list once: one line per
  accessory with its type, name and `deviceId`, `new` on the ones Homebridge did
  not know, and a closing "Ready: ..." line that says what changed. A device the
  plugin does not expose is named, with its type and `deviceId`.
- The per-accessory details (UUID, context) and the devices excluded by your
  settings are logged in debug mode only.
- The warning when the gateway stops reporting an accessory now names it.

## 1.0.1

- The settings page of the plugin in the Homebridge UI links to the README of
  this fork, next to the upstream wiki.
- First version released from GitHub: staged on npm by the Release workflow and
  approved with 2FA. No change in behaviour.

## 1.0.0

First version of the fork, based on upstream 0.34.1 and the fix that follows it
on `main` (accessories are kept when a scan reports no devices).

- No more "This plugin threw an error from the characteristic 'Current
  Position' ... Socket instance is closing/closed" in the log. Delta Dore's
  relay (`mediation.tydom.com`) drops the connection every so often, and every
  HomeKit read made during the few seconds before the reconnection threw. A
  read now answers with the last state the gateway reported, and with "No
  Response" when there is none yet, without a log line.
- Every read and write handler reports a failure to HomeKit as "No Response"
  instead of an unhandled error, including an unreachable device. A failed
  write is still logged as a warning.
- The plugin reconnects by itself, with a wait capped at one minute. The
  backoff of `tydom-client` could reach days after an outage of an hour or two,
  which left the accessories without response until Homebridge was restarted.
- A connection attempt is abandoned after 30 seconds and restarted with a fresh
  client: a login or a handshake that hung used to stop every later
  reconnection.
- At startup, the plugin keeps trying to connect and to read the device list
  until it succeeds, instead of giving up after ten attempts (about half an
  hour) or after one failed scan.
- A short disconnection is logged as one "Reconnected ... after Ns" line instead
  of three warnings. A warning is logged when the gateway stays unreachable, and
  an info line when it is back.
- Update `zod` to 4.6.7 for its security fix (GHSA-mrhx-c7xc-m3w5, memory
  exhaustion on large collections) and `tydom-client` to 0.16.1. Update the
  development tools (vitest, oxfmt, tsdown, oxlint, tsx, homebridge) so
  `npm audit` reports no vulnerability.
- Published on npm as `homebridge-tydom-mk`, with release notes in the Homebridge
  UI taken from this changelog.
