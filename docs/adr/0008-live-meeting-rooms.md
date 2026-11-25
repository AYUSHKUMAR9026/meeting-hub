# ADR 0008 — Self-hosted meeting rooms

Phase 8 replaces the Google Meet bot spike with in-app rooms. LiveKit Server and Egress run in Docker using the existing Redis and Garage bucket. The server SDK, browser SDK and React components provide room management and WebRTC controls. API access remains workspace-scoped.

## Consent and access

Owners, admins and the meeting creator may start and end a room. Joining requires a linked meeting participant or an owner/admin role. Other callers receive the uniform missing-resource response. A room token lasts two minutes, identifies the authenticated user and grants access to one session only. Recording defaults on. Publishing requires the persisted acknowledgement when recording is on. The host chooses recording at start and all attendees see that choice.

## Persistence and recording

Postgres generates UUIDv7 session and attendance keys. A partial unique index allows one active session per meeting. A workspace advisory lock serializes the concurrent-room limit. Egress writes mixed audio and separate microphone track files beneath the meeting storage prefix. Track records link to attendance and store milliseconds relative to the mixed audio start, using Egress file timestamps and export creation times as a fallback. Phase 9 can use those assets for speaker attribution.

Mixed capture starts with the first acknowledged join. Egress requires an output extension, so it writes a temporary .ogg object. Finalization copies that object to the existing extension-free recording key, verifies its size and removes the temporary object. Both keys share the meeting prefix for purge recovery.

The pinned local stack uses LiveKit Server 1.9.11 and Egress 1.15.0. Mixed capture calls `startRoomCompositeEgress` with `audioOnly: true`, without a layout or custom compositor URL. Egress 1.15 supplies native audio mixing; the earlier 1.10 experiment depended on Chrome compositor startup and could miss short calls. Participant microphone capture uses direct track Egress. Cameras and screen sharing stay in the live room; Phase 8 saves audio only.

The mixed audio completion writes recording.uploaded in the same transaction as its recording row. Processing retains its existing pipeline versions. Original lookup also accepts mixed_audio. Participant tracks are retained for later use. Meeting purge cascades sessions and attendance and sweeps the meeting storage prefix.

Webhook verification uses LiveKit's signed body digest and token validation, event freshness and durable event IDs. The maintenance worker reconciles room timeouts and completed exports.

Default limits are 12 participant reservations per room, three concurrent sessions per workspace, 60 minutes per session and a 60-second empty/departure timeout. Join reservations count toward capacity before the browser connects and last until a departure event or session end. Join tokens expire after two minutes; LiveKit handles token renewal for connected clients. The recording choice is fixed for the session. Rooms cannot be restarted after ending.

The sweep runs with the processing maintenance interval (60 seconds by default). It ends expired or missing rooms, retries provider shutdown for sessions already marked ended, and reconciles pending/active exports after session end. Lost completion webhooks can therefore recover through provider status and object checks. A start request whose result is lost before its Egress ID is stored is marked failed after a minute; failed exports are surfaced to attendees and are not automatically restarted. Provider/storage failures are retried by maintenance. Deletion stops room and track exports before sweeping objects and cascading rows. Receipts cascade through their workspace-scoped session foreign key.

Only mixed audio emits `recording.uploaded`; it follows the existing `prepare_media` → `transcribe` → `analyze` pipeline when those flags are enabled. Separate tracks carry attendance links and relative start offsets but do not trigger transcription or speaker matching. There is no Phase 9 implementation, external meeting bot or paid recording service. The superseded bot investigation remains under `docs/spikes` as historical material.

## Development and production

Enable rooms.enabled for the selected workspace and use ROOM_PROVIDER=livekit for browser calls. ROOM_PROVIDER=fake supports lifecycle tests and synthetic audio. Run Docker Compose with the rooms profile. Configure the API's reachable callback address when using a different development port.

LiveKit uses TCP 7880 for API/WebSocket, TCP 7881 for ICE fallback and UDP mux 7882 in this development configuration. A conventional UDP range is 50000–60000 when mux is disabled. For two devices on a LAN, advertise an address both can reach and set LIVEKIT_PUBLIC_URL accordingly.

Production needs trusted TLS for HTTPS/WSS, a correctly advertised public ICE address, firewall rules, TURN/TLS for restrictive networks, rotated credentials, protected Redis/S3, and sufficient Egress CPU/memory. Browser camera, microphone and screen capture require secure contexts. Resource sizing and production deployment remain operational work for that environment.

## Verification and manual two-browser check

The optional `LiveKit room browser test` workflow provisions the real Compose profile and runs two isolated Chromium contexts with fake camera/microphone devices. Transcription and analysis use local fake providers. The test checks consent gating, both participants and remote audio playback, host termination, Ready status, a visible document and a working transcript citation. This verifies WebRTC and real Egress media capture, not physical hardware or external AI quality.

For a manual check:

1. Start the normal infrastructure and the `rooms` profile, migrate a fresh verification database, and run the API, worker and web app against it. Do not reset an existing development database or its volumes. If Mailpit ports are occupied, set `MAILPIT_SMTP_PORT`/`MAILPIT_UI_PORT` for Compose and matching `SMTP_PORT`/`MAILPIT_URL` for the app/test.
2. Enable `rooms.enabled`, `pipeline.media`, `transcription.enabled` and `analysis.enabled` for the workspace; use `ROOM_PROVIDER=livekit` and fake transcription/analysis for a local check.
3. Sign in as the owner and an invited admin in separate browser profiles. Create a meeting, leave recording enabled, and start it. Before acknowledging the notice, verify that joining/publishing is unavailable. Acknowledge in both profiles, choose devices and join.
4. Speak in turn, verify remote audio/video, mute/unmute and leave/rejoin. End for everyone as the host; both browsers should return to the meeting and eventually show Ready, transcript text and cited decisions/actions.
5. Verify one `mixed_audio` recording plus normalized audio, and separate `participant_track` rows with nonempty objects, attendance IDs and nonnegative start offsets. Delete the meeting and verify its objects and session/receipt rows are purged. Repeat with recording off and confirm no recordings are created.

Automated real-media verification has used Chromium fake devices. Physical microphones/cameras, LAN devices, TURN and production networking remain untested. Off-session recording failures are displayed; Phase 8 does not provide an automatic recording restart or a re-recording workflow.

[LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/) · [Self-hosted Egress](https://docs.livekit.io/transport/self-hosting/egress/)
