# yt

# Loading playlist

```bash
 $ npm run playlist
```

It will ask what it needs.
This always creates `yt.m3u` playlist which can be played with vlc player.
This will also try to add links to the Sonos\* player's playlist (skipped if no sonos device is found).

This reads list of songs from googlesheets. Create a sheet with columns `Name` and `VideoID`.

Example:
| Name      |	VideoID                     |
| --------- | --------------------------- |
| Cool Song |	https://youtu.be/Azbycxdwev |

You will need googlesheets `url` and sheet's `title`.

\* Please verify the sonos ip discovered by this. It is occasionally wrong. Enter an invalid ip if you don't want to add links to Sonos playlist.

## Authentication
Follow instructions in https://theoephraim.github.io/node-google-spreadsheet/#/getting-started/authentication?id=service-account to set up Service Account, and download json credentials file.

Copy this JSON file under this app's root directory, and rename it as `gdrive-auth.json`.

```
$ mv /path-to/somename-zzzz-yyy.json ./gdrive-auth.json
```

# Running server

```bash
 $ npm start

 or

 $ PORT=80 npm start

 or

 $ node server --port 80
```

Audio/Video files are cached under `cache` folder. Manually cleaning it regularly is advised.

# Running on Termux (Android)

Works on Termux.

Install nodejs, ffmpeg and git
```
$ pkg install nodejs ffmpeg git
```

Enabling `Developer Options` may be required to access the server ip.
