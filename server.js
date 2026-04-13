const http = require("http");
const fs = require("fs");
const path = require("path");
const Busboy = require("busboy");

const port = process.env.PORT || 4000;
const publicDir = __dirname;
const episodesPath = path.join(publicDir, "episodes.json");
const liveConfigPath = path.join(publicDir, "live-config.json");
const uploadsDir = path.join(publicDir, "mp3");
const imagesDir = path.join(publicDir, "images");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

function sendFile(res, filePath, contentType = "text/html") {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function sendFileWithRange(req, res, filePath, contentType) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const size = stat.size;
    const rangeHeader = req.headers.range;
    if (!rangeHeader) {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": size,
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": size,
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    let start = match[1] === "" ? 0 : parseInt(match[1], 10);
    let end = match[2] === "" ? size - 1 : parseInt(match[2], 10);
    end = Math.min(end, size - 1);
    start = Math.min(start, end);
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": chunkSize,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

function loadEpisodes(callback) {
  fs.readFile(episodesPath, "utf8", (err, data) => {
    if (err) {
      if (err.code === "ENOENT") return callback(null, []);
      return callback(err);
    }
    try {
      const episodes = JSON.parse(data);
      callback(null, episodes);
    } catch (e) {
      callback(e);
    }
  });
}

function saveEpisodes(episodes, callback) {
  fs.writeFile(episodesPath, JSON.stringify(episodes, null, 2), "utf8", callback);
}

function loadLiveConfig(callback) {
  fs.readFile(liveConfigPath, "utf8", (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        return callback(null, { enabled: false, liveUrl: "" });
      }
      return callback(err);
    }
    try {
      const parsed = JSON.parse(data);
      const enabled = !!parsed.enabled;
      const liveUrl = typeof parsed.liveUrl === "string" ? parsed.liveUrl : "";
      callback(null, { enabled, liveUrl });
    } catch (e) {
      callback(e);
    }
  });
}

function saveLiveConfig(config, callback) {
  const enabled = !!(config && config.enabled);
  const liveUrl = config && typeof config.liveUrl === "string" ? config.liveUrl : "";
  fs.writeFile(liveConfigPath, JSON.stringify({ enabled, liveUrl }, null, 2), "utf8", callback);
}

function sanitizeFilename(filename, fallback) {
  const safe = path.basename(String(filename || "").trim());
  return safe || fallback;
}

const server = http.createServer((req, res) => {
  const rawPath = req.url.split("?")[0] || "/";
  const requestPath = rawPath.replace(/\/+$/, "") || "/";

  if (requestPath === "/") {
    const indexPath = path.join(publicDir, "index.html");
    return sendFile(res, indexPath, "text/html");
  }

  if (requestPath === "/admin") {
    const adminPath = path.join(publicDir, "admin.html");
    return sendFile(res, adminPath, "text/html");
  }

  if (requestPath === "/api/episodes" && req.method === "GET") {
    loadEpisodes((err, episodes) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not read episodes" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(episodes));
    });
    return;
  }

  if (requestPath === "/api/episodes" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const episodes = Array.isArray(parsed) ? parsed : [];
        saveEpisodes(episodes, (err) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not save episodes" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (requestPath === "/api/live-config" && req.method === "GET") {
    loadLiveConfig((err, config) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not read live config" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(config));
    });
    return;
  }

  if (requestPath === "/api/live-config" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const enabled = !!parsed.enabled;
        const liveUrl = typeof parsed.liveUrl === "string" ? parsed.liveUrl.trim() : "";
        if (enabled && !liveUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "liveUrl is required when enabled" }));
          return;
        }
        saveLiveConfig({ enabled, liveUrl }, (err) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not save live config" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (requestPath === "/upload/episode" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Expected multipart form upload" }));
      return;
    }
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fields: 10, fileSize: 200 * 1024 * 1024 }
    });
    const fields = {};
    let filename = null;
    let audioUrl = null;
    let uploadWriteError = null;
    let uploadLimitHit = false;
    let responded = false;

    function reply(status, payload) {
      if (responded) return;
      responded = true;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, file, info) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      filename = sanitizeFilename(info && info.filename, "episode.mp3");
      const targetPath = path.join(uploadsDir, filename);
      audioUrl = "mp3/" + filename;

      const output = fs.createWriteStream(targetPath);
      file.on("limit", () => {
        uploadLimitHit = true;
        output.destroy();
      });
      file.on("error", (err) => {
        uploadWriteError = err;
      });
      output.on("error", (err) => {
        uploadWriteError = err;
      });
      file.pipe(output);
    });

    busboy.on("error", () => {
      reply(400, { error: "Malformed multipart form data" });
    });

    busboy.on("close", () => {
      if (!filename || !audioUrl) {
        reply(400, { error: "No file found in upload" });
        return;
      }
      if (uploadLimitHit) {
        reply(413, { error: "File too large (max 200MB)" });
        return;
      }
      if (uploadWriteError) {
        reply(500, { error: "Could not save uploaded file" });
        return;
      }

      loadEpisodes((cfgErr, episodes) => {
        const list = cfgErr || !Array.isArray(episodes) ? [] : episodes.slice();
        const date = fields.date || new Date().toISOString().slice(0, 10);
        const title = fields.title || "Episode";
        const description = fields.description || "";
        const colorRaw = String(fields.color || "").toLowerCase();
        const allowedColors = ["red", "orange", "yellow", "green", "blue", "indigo", "violet"];
        const color = allowedColors.includes(colorRaw) ? colorRaw : "blue";

        list.push({ date, title, description, audioUrl, color });

        saveEpisodes(list, (saveErr) => {
          if (saveErr) {
            reply(500, { error: "Could not update episodes" });
            return;
          }
          reply(200, { filename, audioUrl });
        });
      });
    });

    req.pipe(busboy);
    return;
  }

  if (requestPath === "/upload/month-image" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Expected multipart form upload" }));
      return;
    }
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fields: 5, fileSize: 25 * 1024 * 1024 }
    });
    const fields = {};
    const tmpName = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    const tmpPath = path.join(imagesDir, tmpName);
    let hasFile = false;
    let uploadWriteError = null;
    let uploadLimitHit = false;
    let responded = false;

    function reply(status, payload) {
      if (responded) return;
      responded = true;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, file) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      hasFile = true;
      const output = fs.createWriteStream(tmpPath);
      file.on("limit", () => {
        uploadLimitHit = true;
        output.destroy();
      });
      file.on("error", (err) => {
        uploadWriteError = err;
      });
      output.on("error", (err) => {
        uploadWriteError = err;
      });
      file.pipe(output);
    });

    busboy.on("error", () => {
      reply(400, { error: "Malformed multipart form data" });
    });

    busboy.on("close", () => {
      if (!hasFile) {
        reply(400, { error: "No file found in upload" });
        return;
      }
      if (uploadLimitHit) {
        fs.unlink(tmpPath, () => {});
        reply(413, { error: "File too large (max 25MB)" });
        return;
      }
      if (uploadWriteError) {
        fs.unlink(tmpPath, () => {});
        reply(500, { error: "Could not save month image" });
        return;
      }

      const monthKeyRaw = (fields.month || "").toLowerCase();
      const allowed = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"
      ];
      if (!allowed.includes(monthKeyRaw)) {
        fs.unlink(tmpPath, () => {});
        reply(400, { error: "Invalid month" });
        return;
      }

      const yearStr = (fields.year || "").trim();
      const yearNum = Number(yearStr);
      if (!yearStr || !Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 3000) {
        fs.unlink(tmpPath, () => {});
        reply(400, { error: "Invalid year" });
        return;
      }

      const targetName = `month-${yearNum}-${monthKeyRaw}.jpg`;
      const targetPath = path.join(imagesDir, targetName);
      fs.rename(tmpPath, targetPath, (err) => {
        if (err) {
          fs.unlink(tmpPath, () => {});
          reply(500, { error: "Could not save month image" });
          return;
        }
        reply(200, { month: monthKeyRaw, year: yearNum, filename: targetName });
      });
    });

    req.pipe(busboy);
    return;
  }

  if (requestPath === "/api/delete-month-image" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const monthKeyRaw = String(parsed.month || "").toLowerCase();
        const allowed = [
          "january","february","march","april","may","june",
          "july","august","september","october","november","december"
        ];
        if (!allowed.includes(monthKeyRaw)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid month" }));
          return;
        }
        const yearStr = String(parsed.year ?? "").trim();
        const yearNum = Number(yearStr);
        if (!yearStr || !Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 3000) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid year" }));
          return;
        }
        const targetName = `month-${yearNum}-${monthKeyRaw}.jpg`;
        const targetPath = path.join(imagesDir, targetName);
        const resolved = path.resolve(targetPath);
        const resolvedImages = path.resolve(imagesDir);
        if (!resolved.startsWith(resolvedImages + path.sep)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid path" }));
          return;
        }
        fs.unlink(resolved, (err) => {
          if (err) {
            if (err.code === "ENOENT") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, deleted: false }));
              return;
            }
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not delete month image" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, deleted: true }));
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  const relativePath = requestPath.replace(/^\//, "");
  const filePath = path.join(publicDir, decodeURIComponent(relativePath));
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".json": "application/json"
  };

  const contentType = mimeTypes[ext] || "application/octet-stream";
  sendFileWithRange(req, res, filePath, contentType);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use — another Node server (or app) is still listening.\n\n` +
        `Free the port, then run npm start again:\n` +
        `  kill $(lsof -t -iTCP:${port} -sTCP:LISTEN)\n\n` +
        `Or use a different port:\n` +
        `  PORT=4001 npm start\n`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`Avalon Radio site running at http://localhost:${port}`);
});

