# LiveVault

The multitrack library for [LiveWebMixer](https://github.com/leonidis2013/LiveWebMixer). Host your multitrack sessions in one place, keep every change as a version, open any version in LiveWebMixer with one click, and keep the mixes and Main LR recordings people make for review.

- Runs in one Docker container, controlled entirely from a web page.
- **One standard format:** every track is stored as 96 kHz / 24-bit WAV, the SQ-5's USB rate. Files at other rates are converted on import. The original file is kept too (you can turn that off).
- **Stored once:** each audio file is stored by its content hash. A track that appears in ten versions takes the space of one, and uploading the same file twice costs nothing.
- **Versions:** edits (new tracks, new audio for a track, renames, track order, reference or not) collect as unsaved changes. Saving them makes a new major.minor.patch version with a note, and the history shows what changed. Any old version can be viewed, opened in LiveWebMixer or restored.
- **Organizing:** band/artist, type (service, rehearsal, purchased, training pack, studio), recorded date, key, tempo, difficulty, tags, "listen for" notes and training notes. The library filters by band, type, tags and difficulty (with counts) and sorts by name, date or band.
- **Licenses:** mark purchased sessions with who holds the license and its terms, and restrict them to people with "Licensed sessions" access or to named people.
- **People and permissions:** every user gets their own set: add and edit, edit info, delete, download, mix, see all mixes, licensed sessions. Admins can do everything.
- **Preview player:** waveforms for every track, play the whole session in the browser with mute and solo, and A/B against the reference mix.
- **Mixes:** each person's LiveWebMixer mix is stored with the exact version it was made on. Trainees see their own mixes plus any mix marked as a reference.
- **Recordings for review:** press Record in LiveWebMixer and the Main LR mix is captured while the song plays and saved to LiveVault. It is linked to the version and the mix, plays back with an A/B against the reference mix at the same point in the song, and has a review notes field for feedback.
- **Import your master folder:** mount it read-only at `/import` and use Library > Import > From the master folder. LiveVault finds the songs even when the folder is not organized the same way throughout (a song is a folder with audio in it, or one whose subfolders are parts of a song such as Stems, Drums or Click), takes the band from the folder above a song, shows the plan, and imports on the server without uploading anything. Folders already imported are marked.
- **Track tools:** tracks are sorted into instrument groups (drums, percussion, bass, guitars, keys, vocals, click & tracks) with colors, which LiveWebMixer uses too; silent tracks are flagged and start as Not used; tracks that are a different length from the rest are pointed out. Rename by clicking a name, reorder by dragging, and everything else is in each track's ⋯ menu. Changes save as a new version with the number chosen for you (new or replaced audio: minor; names, order, groups: patch).
- **Drop folders in the browser:** drag a folder of tracks, a folder of song folders, or loose files onto the library (or pick a folder). LiveVault shows what becomes a session (each folder of tracks, each song folder with its subfolders, or all one session) before uploading, then saves version 1.0.0 once the tracks have converted. Dropping a folder onto a session's track list adds everything in it.
- **Recorded date:** each session has the date it was recorded, filled in from the oldest file (the modified date for files dropped in the browser, which is all a browser can see; the creation date for the watch folder). Change it by hand any time; the library can sort newest first.
- **Watch folder:** drop a folder of tracks (or a zip) into a shared folder and it becomes a session with version 1.0.0 on its own. Interleaved multichannel files are split into one track per channel.

## Install

```
docker compose up -d
```

Open **https://<server IP>:9543**, accept the certificate warning once, and create the admin account. Then add everyone else under **Users**.

For TrueNAS, paste `truenas-app.yaml` into Apps > Discover Apps > Custom App > Install via YAML.

LiveVault keeps the audio in the library dataset (below) and everything else (sessions, mixes, users, previews, certificate) in the `livevault-data` volume. Port 9580 is plain http; LiveWebMixer reaches LiveVault through it, and a reverse proxy can use it too.

### Audio library on a drive

The YAML mounts two folders: the library dataset at `/library` (LiveVault's audio, below) and your master multitrack folder at `/import`, read-only (LiveVault only reads from it). The library: LiveVault keeps all audio there (tracks and Main LR recordings), and everything else (users, settings, previews, the 48 kHz copies LiveWebMixer plays) in the `livevault-data` volume. Each session gets a readable folder:

```
Goodness of God (2026-03-01)/
  v1.0.0/01 Kick.wav, 02 Bass.wav, … REF Full Mix.wav
  v1.0.1/…
  Recordings/2026-11-14 Run 1 (v1.0.1).wav
  Mixes/Sam's mix (v1.0.1).json
.livevault/          the one stored copy of every file (LiveVault's own; leave it alone)
```

The version folders are hard links to the stored copy, so a track that is in five versions takes the space of one. LiveVault owns these folders: it renames them when a session is renamed and removes them when a session is deleted, so share the dataset over SMB **read-only** and make changes in LiveVault. The stored files are read-only too, so a hard-linked track cannot be changed by accident.

On TrueNAS: create a dataset (for example `tank/LiveVault Library`), give user ID 1000 Modify permission in its ACL (that is the user LiveVault runs as), put its path on the left of the `/library` line, and add a read-only SMB share for it. Without a `/library` mount, the audio stays in the volume as before. When you add the mount later, LiveVault moves the existing audio to the drive the next time it starts (Settings > Storage shows where it is).

### Watch folder (optional)

The watch folder needs to be a folder you can drop files into from other computers, so it is a dataset too. Share a dataset over SMB and mount it at `/watch` (see the commented line in the YAML). The container runs as user 1000, so give that user write access to the share; imported folders are then moved into `_imported`. LiveVault waits until a folder has stopped changing for 30 seconds before importing it, so a slow copy is fine.

## Connect LiveWebMixer

In LiveVault **Settings**, enter the LiveWebMixer address (for example `https://192.168.1.20:9443`). That is all: every session (and every row in the library) gets **Open in LiveWebMixer**, which opens LiveWebMixer in a new tab, connects it as the person who clicked, and goes straight into the mixer. Channels come in LiveVault's track order and group colors, LiveWebMixer shows the session and version with a link back, and mixes and Main LR takes are saved to LiveVault under that person's name. LiveVault starts preparing the mixer's copies of a version (48 kHz FLAC and Opus) as soon as it is saved, and the button shows how far along that is.

LiveWebMixer reaches LiveVault at the address your browser is using. If you open LiveVault by a name the LiveWebMixer container cannot look up (such as `truenas.local`), fill in **LiveVault address for LiveWebMixer** in Settings with the IP address instead, for example `http://192.168.1.20:9580`.

You can still connect LiveWebMixer by hand (Setup > LiveVault library > Connection) with an access token from **My account**; LiveWebMixer 0.4.0 or newer is needed for the one-click link.

## Good to know

- 96 kHz / 24-bit is large: about 17 MB per mono track per minute. A one-hour, 32-track service recording is about 33 GB. **Settings > Storage** shows the totals and the free space.
- Deleting sessions and discarding uploads leaves their audio on disk until an admin presses **Clean up unused audio**.
- There is no password recovery by email; an admin sets a new password under Users.

## Updating

Versions are major.minor.patch in `package.json`. A push to `main` builds and publishes `ghcr.io/leonidis2013/livevault` (`latest` and the version tag).

`npm test` runs an end-to-end test of the server (no packages to install; the audio parts need ffmpeg).
