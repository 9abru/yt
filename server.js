'use strict';
const assert = require('assert');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ytdl = require('ytdl-core');
const FFmpeg = require('fluent-ffmpeg');
const PassThrough = require('stream').PassThrough;

let port = process.env.PORT || 8090;
const ip = (function getIp() {
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
})();

if (process.argv.length > 2) {
  for (let i = 2; i < process.argv.length; i++) {
    var opt = process.argv[i];
    switch (opt) {
      case "-p":
      case "--port":
        var p = parseInt(process.argv[++i]); //first arg is port
        if (!isNaN(p)) port = p;
        break;
        case "-h":
        case "-?":
        case "--help":
          console.warn(" [-p,--port <Port>] [-h,-?,--help]");
          process.exit();
          break;
    }
  }
}

console.log("Port bound to %d", port);

class ProxyService {
  constructor(options={}) {
    this._ytPlayer = new YouTubePlayer(options);
  }

  start (port) {
    assert(!this._server);
    this._server = http.createServer(this._onRequest.bind(this))
                       .listen(port, ()=> {
                         const address = this._server.address();
                         console.log(`http://${ip||address.address}:${address.port}`)
                       });
  }
  stop () {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
    if (this._ytPlayer) {
      this._ytPlayer.clean();
    }
  }
  
  _onRequest(req, res) {
    console.log(`A new request was made by a client ${req.url}`);
    const reqUrl = url.parse(req.url, true);
    const chid = reqUrl.query.chid;
    const name = reqUrl.pathname.replace(/\/+/g,'');
    const vid = reqUrl.query.video||reqUrl.query.vid||reqUrl.query.v;
    const audio = !(['1','true'].includes(vid)) || req.headers['user-agent'].includes('Sonos');
    if (!chid){
      res.writeHead(500, "Missing Channel Id (chid)", {
        'Access-Control-Allow-Origin': '*'
      });
      res.end();
      return;
    }
    this._ytPlayer.playCached(req, res, name, chid, { audio });
  }
}

class YouTubePlayer {
  constructor(options = {}) {
    this._cacheFolder = options.cacheFolder;
    if (!this._cacheFolder) {
      const cacheRoot = path.resolve(__dirname);
      this._cacheFolder = path.join(cacheRoot, 'cache');
    }
    fs.mkdirSync(path.join(this._cacheFolder, 'audio'), { recursive: true });
    fs.mkdirSync(path.join(this._cacheFolder, 'video'), { recursive: true });
    this._active = new Map();
  }
  _buildOptions(audio) {
    const filter = audio ? 
        format => /*!format.bitrate &&*/ format.audioBitrate /*&& format.container === 'm4a'*/ : //audioEncoding: 'aac'
        format => format.bitrate /*&& format.container === 'mp4'*/;
    const quality = audio ? 'highestaudio' : 'highestvideo';
    return { filter, quality };

  }
  getFormat(idlink, audio) {
    const options = this._buildOptions(audio);
    return new Promise((resolve, reject) => {
      ytdl.getInfo(idlink, (err, info) => {
        if (err) {
           reject(err); return;
        }
        const format = ytdl.chooseFormat(formats, options);
        if (!format) { reject(new Error(`Unable to get highest quality ${audio} format`)); return; }
        resolve(format);
      });
    });
  }
  _sendError (res, errMsg) {
    console.error("Sending 500: %s", errMsg);
    res.writeHead(500, errMsg, {
      "Access-Control-Allow-Origin": "*"
    });
    res.end("500: " + errMsg);
  }
  clean() {
    this._active.forEach(({ ffmpeg, cacheFile }) => {
      if (ffmpeg) ffmpeg.kill();
      if (cacheFile) {
        fs.unlink(cacheFile, (err) => {
          if (err) console.error(`Unable to delete ${cacheFile} on error`);
        });
      }
    });
    this._active.clear();
  }
  _getMp3FCacheFilePath(name, idlink, options={}) {
    const category = options.audio ? 'audio' : 'video'; 
    return path.join(this._cacheFolder, category, `${idlink}_${name}`);
  }
  playFromCache(req, res, cacheFile, idlink) {
    console.error(`[${idlink}] Start playing cache`);
    const fstrm = fs.createReadStream(cacheFile);
    fstrm.on('error', (err) => {
      console.error(`[YouTube ${idlink}]: Error reading cache file ${cacheFile}`, err);
      this._sendError(res, 'Error');
    });
    fstrm.pipe(res);
  }
  _createStream(options) {
    const stream = new PassThrough({
      highWaterMark: options && options.highWaterMark || null,
    });
    stream.destroy = () => { stream._isDestroyed = true; };
    return stream;
  }
  async playCached (req, res, name, idlink, options={}) {
    const cacheFile = this._getMp3FCacheFilePath(name, idlink, options);
    if (this._active.has(idlink)) {
      setTimeout(()=> {
        this.playFromCache(req, res, cacheFile, idlink);
      }, 2000);
      return;
    }
    try {
      const stats = await fs.promises.stat(cacheFile);
      if (stats.isFile()) {
        if (stats.size > 0) {
          this.playFromCache(req, res, cacheFile, idlink);
          return;
        } else {
          fs.unlink(cacheFile, (err) => {
            if (err) console.error(`Unable to delete zero byte ${cacheFile} on error`);
          });
        }
      }
    } catch (ex) {
      console.log(`No cache ${cacheFile}. Loading...`);
    }
    // Skip if already downloading and skip if already downloading 5
    if (this._active.has(idlink) || this._active.size > 5) {
      setTimeout(()=> {
        this._sendError(res, 'Busy');
      }, 2000);
      return;
    }
    console.error(`[${idlink}] Start playing`);
    const ytoptions = this._buildOptions(options.audio);
    const ytstrm = ytdl(idlink, ytoptions);
    const fstrm = fs.createWriteStream(cacheFile, {flags: 'w'})
    let ffmpeg;
    let reqclosed = false;
    res.on('close', () => reqclosed = true);
    req.on('close', () => reqclosed = true);
    const onclose = (source, err) => {
      if (err instanceof Error) {
        const errMsg = `[YouTube ${idlink}] Error processing during ${source}`;
        console.error(errMsg, err);
      }
      if (this._active.has(idlink)) {
        this._active.delete(idlink);
        if (ffmpeg) {
          ffmpeg.kill();
          ffmpeg = null;
        }
        if (err) {
          fs.unlink(cacheFile, (err) => {
            if (err) console.error(`Unable to delete ${cacheFile} on error`);
          });
        }
      }
      if (reqclosed) return;
      if (err instanceof Error) {
        reqclosed = true;
        this._sendError(res, 'Error');
      }
    };
    ytstrm.on('error', onclose.bind(this, 'ytstrmerror'));
    ytstrm.on('info', (info, format) => {
      console.log(`[${idlink}] Length: ${format.clen}`);
    });
    ytstrm.on('progress', (chunkSize, totalSoFar, contentLength) => {
      console.log(`[${idlink}]`, chunkSize, totalSoFar, contentLength);
    });
    ytstrm.on('close', onclose.bind(this, 'ytstrmclose'));
    fstrm.on('error', onclose.bind(this, 'fstrmerror'));
    fstrm.on('close', onclose.bind(this, 'fstrmerror'));

    if (options.audio) {
      ffmpeg = new FFmpeg(ytstrm)
        .format('mp3')
        .audioBitrate(128)
        .on('close', onclose.bind(this, 'ffmpegclose'))
        .on('error', (err) => {
          console.error(`[FFMPEG ERROR ${idlink}]:`, err);
          onclose.call(this, 'ffmpegerr')
        });
      ffmpeg.on('close', onclose.bind(this, 'ffmpegclose'));
      const pstrm = this._createStream(options)
      ffmpeg.pipe(pstrm);
      pstrm.pipe(fstrm);
      pstrm.pipe(res);
    } else {
      ytstrm.pipe(fstrm);
      ytstrm.pipe(res);
    }
    this._active.set(idlink, { ffmpeg, cacheFile });
  }
  play (req, res, name, idlink, options={}) {
    if (this._active.has(idlink)) {
      setTimeout(()=> {
        this._sendError(res, 'Busy');
      }, 2000);
      return;
    };
    console.error(`[${idlink}] Start playing`);
    let ffmpeg;
    const close = (from) => {
      console.error(`[${idlink}] Close [${from}]`);
        // res.end();
      if (this._active.has(idlink)) {
        this._active.delete(idlink);
        if (ffmpeg) {
          ffmpeg.kill();
          ffmpeg = null;
        }
      }
    };
    res.on('close', close.bind(this, 'resclose'));
    req.on('close', close.bind(this, 'reqclose'));

    const ytoptions = this._buildOptions(options.audio);
    const ytstrm = ytdl(idlink, ytoptions);
    ytstrm.on('error', (err) => {
      const errMsg = `[Error playing ${idlink}`;
      console.error(`[YouTube ${idlink}]: ${errMsg}`, err);
      this._sendError(res, errMsg);
      close.call(this, 'ustrmerror');
    });
    ytstrm.on('progress', (chunkSize, totalSoFar, contentLength) => {
      console.log(`[${idlink}]`, chunkSize, totalSoFar, contentLength);
    });
    ytstrm.on('close', close.bind(this, 'ustrmclose'));

    if (options.audio) {
      ffmpeg = new FFmpeg(ytstrm)
        .format('mp3')
        .audioBitrate(128)
        .on('close', close.bind(this, 'ffmpegclose'))
        .on('error', (err) => {
          console.error(`[FFMPEG ERROR ${idlink}]:`, err);
          close.call(this, 'ffmpegerr')
        });
      this._active.set(idlink, { ffmpeg });
      ffmpeg.pipe(res);
      ffmpeg.on('close', close.bind(this, 'ffmpegclose'));
    } else {
      ytstrm.pipe(res);
    }
    //ffmpeg.format('mp3').pipe(res);
  }
}
const service = new ProxyService();
service.start(port);

process.on('SIGINT', function() {
  console.log('SIGINT');
  service.stop();
  process.exit();
});

process.on('exit', function(code) {
  console.log("EXIT START: Exiting with code: %s.", code);
  service.stop();
  console.log("EXIT END: Exited with code: %s.", code);
});
