# LiveVault

The multitrack library for [LiveWebMixer](https://github.com/leonidis2013/LiveWebMixer). Host your multitrack sessions in one place, keep every change as a version, open any version in LiveWebMixer with one click, and keep the mixes and Main LR recordings people make for review.

- Runs in one Docker container, controlled entirely from a web page.
- **One standard format:** every track is stored as 96 kHz / 24-bit WAV, the SQ-5's USB rate. Files at other rates are converted on import. The original file is kept too (you can turn that off).
- **Stored once:** each audio file is stored by its content hash. A track that appears in ten versions takes the space of one, and uploading the same file twice costs nothing.
- **Versions:** edits (new tracks, new audio for a track, renames, track order, reference or not) collect as unsaved changes. Saving them makes a new major.minor.patch version with a note, and the history shows what changed. Any old version can be viewed, opened in LiveWebMixer or restored.
- **Organizing:** source (SQ-5 recording, purchased, training pack, studio/DAW), artist, tempo, key, difficulty, tags, "listen for" notes and training notes, with search and filters.
- **Licenses:** mark purchased sessions with who holds the license and its terms, and restrict them to people with "Licensed sessions" access or to named people.
- **People and permissions:** every user gets their own set: add and edit, edit info, delete, download, mix, see all mixes, licensed sessions. Admins can do everything.
- **Preview player:** waveforms for every track, play the whole session in the browser with mute and solo, and A/B against the reference mix.
- **Mixes:** each person's LiveWebMixer mix is stored with the exact version it was made on. Trainees see their own mixes plus any mix marked as a reference.
- **Recordings for review:** press Record in LiveWebMixer and the Main LR mix is captured while the song plays and saved to LiveVault. It is linked to the version and the mix, plays back with an A/B against the reference mix at the same point in the song, and has a review notes field for feedback.
- **Drop folders in the browser:** drag a folder of tracks, a folder of song folders, or loose files onto the library (or pick a folder). LiveVault shows what becomes a session (each folder of tracks, each song folder with its subfolders, or all one session) before uploading, then saves version 1.0.0 once the tracks have converted. Dropping a folder onto a session's track list adds everything in it.
- **Recorded date:** each session has the date it was recorded, filled in from the oldest file (the modified date for files dropped in the browser, which is all a browser can see; the creation date for the watch folder). Change it by hand any time; the library can sort newest first.
- **Watch folder:** drop a folder of tracks (or a zip) into a shared folder and it becomes a session with version 1.0.0 on its own. Interleaved multichannel files are split into one track per channel.

## Install

```
docker compose up -d
```

Open **https://<server IP>:9543**, accept the certificate warning once, and create the admin account. Then add everyone else under **Users**.

For TrueNAS, paste `truenas-app.yaml` into Apps > Discover Apps > Custom App > Install via YAML.

Everything LiveVault keeps (tracks, sessions, mixes, recordings, users, certificate) is in the `livevault-data` volume. Port 9580 is plain http; LiveWebMixer reaches LiveVault through it, and a reverse proxy can use it too.

### Watch folder (optional)

The watch folder is the one thing that is not inside the volume, because it needs to be a folder you can drop files into from other computers. Share a dataset over SMB and mount it at `/watch` (see the commented line in the YAML). The container runs as user 1000, so give that user write access to the share; imported folders are then moved into `_imported`. LiveVault waits until a folder has stopped changing for 30 seconds before importing it, so a slow copy is fine.

## Connect LiveWebMixer

LiveWebMixer 0.3.0 or newer plays sessions straight from LiveVault and saves mixes and Main LR takes back to it, using the API in its `docs/LIVEVAULT-API.md`.

1. In LiveVault, open **My account** (your name, top right) and make an **access token**. Copy it; it is shown once.
2. In LiveWebMixer's Setup, open the **LiveVault library** card and enter LiveVault's http address (for example `http://192.168.1.20:9580`) and the token.
3. In LiveVault **Settings**, enter the LiveWebMixer address (for example `https://192.168.1.20:9443`). Sessions then get an **Open in LiveWebMixer** button that opens that version there.

A token acts as the person who made it, with their permissions: the mixer lists the sessions they may see, and their mix of each version and their takes are saved under their name. Each person keeps one LiveWebMixer mix per version. Remove a token under My account to cut that mixer off.

LiveVault makes 48 kHz FLAC and Opus copies of each track for the mixer in the background when a version is saved, so the first load does not wait for conversion.

## Good to know

- 96 kHz / 24-bit is large: about 17 MB per mono track per minute. A one-hour, 32-track service recording is about 33 GB. **Settings > Storage** shows the totals and the free space.
- Deleting sessions and discarding uploads leaves their audio on disk until an admin presses **Clean up unused audio**.
- There is no password recovery by email; an admin sets a new password under Users.

## Updating

Versions are major.minor.patch in `package.json`. A push to `main` builds and publishes `ghcr.io/leonidis2013/livevault` (`latest` and the version tag).

`npm test` runs an end-to-end test of the server (no packages to install; the audio parts need ffmpeg).
