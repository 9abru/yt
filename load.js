'use strict';
const fs = require('fs');
// const path = require('path');
const readline = require('readline');
const url = require('url');
const os = require('os');
const https = require('https');
const GoogleSpreadsheet = require('google-spreadsheet');
const { Sonos, AsyncDeviceDiscovery } = require('sonos');

function getIp() {
  for (const [ifname, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if ('IPv4' !== iface.family || iface.internal !== false) {
        // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
        continue;
      }
      console.log(`Using ${ifname}->${iface.address}`);
      return iface.address;
    }
  }
}

const questions = {
  inputs: {
    prompt: `Lets agree on few things first!`,
    options: {
      sonosDeviceIp: {
        prompt: `IP of your sonos device. Enter an invalid value if you want to skip updating sonos playlist`
      },
      serverUrl: {
        prompt: 'Base url of the server you are planning to use'
      }
    }
  },
  sources: {
    prompt: `Lets get source of the playlist!`,
    options: [
      {
        prompt: 'We can read playlist of youtube links you have maintained as google sheets. Remember this can be read if it is shared with anyone on internet to view. Use "File | Sharing | Get Link"',
        name: 'googlesheet',
        options: {
          url: {
            prompt: `Enter url of your google sheets. Ex: https://docs.google.com/spreadsheets/d/zzzz-zzzz_zzzz_zzzz/edit?usp=sharing`,
            required: true
          },
          title: {
            prompt: `And the title of the sheet to process.`,
            default: 'party'
          },
          video: {
            prompt: 'Do you want to see video? Audio only is played by default',
            default: 'N'
          },
        }
      },
      {
        prompt: 'We can read your m3u playlist from https link. Like on pastebin',
        name: 'm3u',
        options: {
          url: {
            prompt: `Enter https url of your m3u playlist Ex: https://pastebin.com/raw/zzzzzzz`,
            required: true
          }
        }
      }
    ]
  }
};

async function prompt(rl, qs) {
  return new Promise((resolve) => {
    rl.question(`${qs.prompt} [${qs.default||''}]:`, (answer) => {
      resolve(answer && answer.trim() || qs.default);
    });
  });
}
async function prompts({inputs, sources}) {
  const serverIp = getIp() || '127.0.0.1';
  const serverPort = 8090;
  const serverUrl = `http://${serverIp}:${serverPort}`;
  inputs.options.serverUrl.default = serverUrl;
  try {
    const discovery = new AsyncDeviceDiscovery();
    const sonosDevice = await discovery.discover();
    const sonosDeviceIp = sonosDevice.host;
    console.log(`Sonos device:`, sonosDeviceIp);
    inputs.options.sonosDeviceIp.default = sonosDeviceIp;
  } catch (ex) {
    console.error('Unable to discover sonos device', ex);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const result = { };
  console.log(inputs.prompt);
  for (const [name, qs] of Object.entries(inputs.options)) {
    result[name] = await prompt(rl, qs);
  }
  console.log(sources.prompt);
  for (const source of sources.options) {
    const src = {};
    console.log(source.prompt);
    for (const [name, qs] of Object.entries(source.options)) {
      src[name] = await prompt(rl, qs);
    }
    if (src.url) {
      result[source.name] = src;
      break;
    }
  }
  rl.close();
  console.log(result);
  return result;
}

class PlayListLoader {
  constructor({sonosDeviceIp,  serverUrl}={}) {
    this._sonos = sonosDeviceIp && new Sonos(sonosDeviceIp);
    this._serverUrl = serverUrl;
  }

  syncPlaylist(playlist, dest) {
    return new Promise((resolve, reject) => {
      https.get(playlist, (res) => {
        // console.log('statusCode:', res.statusCode);
        // console.log('headers:', res.headers);
        if (res.statusCode !== 200) {
          reject(new Error(`Error getting file ${playlist} - statusCode: ${res.statusCode}`));
          return;
        }
        try {
          const fstrm = fs.createWriteStream(dest, {flags: 'w'})
          let hasError = false;
          fstrm.on('error', err =>{
            console.error(`Erroe during copy to ${dest}`, err);
            hasError = true;
            reject(err);
          });
          fstrm.on('finish', () => {
            console.log(`Finish copy stream ${dest}`);
            if (!hasError) resolve(dest);
          });
          fstrm.on('close', () => {
            console.log(`Closing copy stream ${dest}`);
            if (!hasError) resolve(dest);
          });
          res.pipe(fstrm);
        } catch(ex) {
          hasError = true;
          console.error(`Exception during createWriteStream of ${dest}`, ex);
          reject(ex);
        }
      }).on('error', reject);
    });
  }

  readM3uPlaylist(playlist) {
    return new Promise((resolve, reject) => {
      https.get(playlist, (res) => {
        // console.log('statusCode:', res.statusCode);
        // console.log('headers:', res.headers);
        if (res.statusCode !== 200) {
          reject(new Error(`Error getting file ${playlist} - statusCode: ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          data = data.split('\n').reduce((o, line) => {
            line = line.trim();
            if (line.length > 0  && !line.startsWith('#')) {
              if (line.startsWith('http')) {
                o.push(line);
              }
            }
            return o;
          }, []);
          resolve(data);
        });
      }).on('error', reject);
    });
  }

  readGoogleSheetPlaylist(gs_id, {title,video='n'}) {
    const playVideo = ['y','yes'].includes(video.toLowerCase());
    return new Promise((resolve, reject) => {
      const doc = new GoogleSpreadsheet(gs_id);
      const load = (sheet) => {
        sheet.getRows({
          offset: 1,
          // limit: 20,
          // orderby: 'col1',
        }, ( err, rows ) => {
          if (err) {
            reject(err);
            return;
          }
          const result = rows.reduce((o, {name, videoid}) => {
            console.log(`Name: ${name}, VideoID: ${videoid}`);
            if (videoid) {
              if (videoid.startsWith('https://')) {
                const videoUrl = url.parse(videoid, true);
                videoid = videoUrl.hostname !== 'youtu.be' ? videoUrl.query.v : videoUrl.pathname.slice(1);
              }
              if (videoid) {
                name = name && name.trim().replace(/\s+/g,'-') || videoid
                o.push(`${this._serverUrl}/${name}.mp3?chid=${videoid}&video=${playVideo}`)
              }
            }
            return o;
          }, []);
          resolve(result);
        });
      };
      doc.getInfo((err, info) => {
        if (err) {
          reject(err);
          return;
        }
        console.log('Loaded doc: '+info.title+' by '+info.author.email);
        const sheet = title && info.worksheets.find((sheet) => sheet.title === title) 
                    || info.worksheets[0];
        console.log(`sheet: ${sheet.title} ${sheet.rowCount}x${sheet.colCount}`);
        load(sheet);
      });
    });
  }

  async load(type='m3u', playlist, options={}) {
    // const mediaFolder = options.mediaFolder || '/var/www/play/music/';
    // await this.syncPlaylist(playlist, path.join(options.mediaFolder, 'music.m3u'));
    let data;
    switch (type) {
      case 'googlesheet':
        console.log(`googlesheet: ${playlist} ${JSON.stringify(options)}`)
        data = await this.readGoogleSheetPlaylist(playlist, options);
        break;
      case 'm3u':
      default:
        console.log(`m3u: ${playlist}`)
        data = await this.readM3uPlaylist(playlist);
        break;
    }
    const m3ufile = `yt.m3u`;
    const m3ufstrm = fs.createWriteStream(m3ufile, {
      flags: 'w',
      defaultEncoding: 'utf8',
      fd: null,
      mode: 0o666,
      autoClose: true
    });
    m3ufstrm.write('#EXTM3U\n');
    m3ufstrm.on('error', console.error.bind(console, `Error writing file ${m3ufile}`));
    m3ufstrm.on('close', console.log.bind(console, `Created file ${m3ufile}`));
    try {
      this._sonos && await this._sonos.flush();
    } catch (ex) {
      console.error(`Error interacting with sonos - SKIPPING SONOS`, ex);
      this._sonos = undefined;
    }
    for (const item of data) {
      //m3ufstrm.write(`\n#EXTINF:-1 group-title=song tvg-name="${url.parse(item).pathname.slice(1)}"`);
      m3ufstrm.write(`\n#EXTINF:-1,${url.parse(item).pathname.slice(1)}`);
      m3ufstrm.write(`\n${item}`);
      this._sonos && await this._sonos.queue(item);
    }
    m3ufstrm.end();
  }
}

async function run() {
  const { sonosDeviceIp, serverUrl, googlesheet, m3u } = await prompts(questions);
  // const { sonosDeviceIp, serverUrl, googlesheet, m3u } = {
  //   sonosDeviceIp: '192.168.1.11',
  //   serverUrl: 'http://192.168.1.10:8090',
  //   googlesheet: {
  //     url: 'https://docs.google.com/spreadsheets/d/........-........../edit#gid=....',
  //     title: 'party',
  //     video: 'N'
  //   }
  // };
  const plLoader = new PlayListLoader({sonosDeviceIp, serverUrl});
  if (googlesheet) {
    const gs_id = ((gslink) => {
      const result = /^https:\/\/docs.google.com\/spreadsheets\/d\/([^\/]+)\//.exec(gslink);
      return (result && result.length >= 2) ? result[1] : gslink;
    })(googlesheet.url);
    return await plLoader.load('googlesheet', gs_id, {title: googlesheet.title, video: googlesheet.video});
  }
  if (m3u) {
    // const m3u_playlist = 'https://pastebin.com/raw/zzzzzzz';
    return await plLoader.load('m3u', m3u.url);
  }
  throw new Error('Nothing to process');
}
run().then(() => {
  console.log('done!!');
}).catch(console.error);
