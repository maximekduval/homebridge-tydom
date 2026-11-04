# Changelog

Changes of `homebridge-tydom-mk`, the fork of
[mgcrea/homebridge-tydom](https://github.com/mgcrea/homebridge-tydom). The
history of the versions before the fork is in the
[upstream changelog](https://github.com/mgcrea/homebridge-tydom/blob/main/CHANGELOG.md).

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
