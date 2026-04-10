const http = require("http");
const fs = require("fs");
const path = require("path");

const port = process.env.PORT || 4000;
const publicDir = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : publicDir;
const episodesPath = path.join(dataDir, "episodes.json");
const liveConfigPath = path.join(dataDir, "live-config.json");
const uploadsDir = path.join(dataDir, "mp3");
const imagesDir = path.join(dataDir, "images");
const monthImagesMapPath = path.join(dataDir, "month-images.json");

let cloudinary = null;
function cloudinaryEnabled() {
  return !!(
    process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET)
  );
}
if (cloudinaryEnabled()) {
  cloudinary = require("cloudinary").v2;
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config();
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
  }
}

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

function loadMonthImagesMap(callback) {
  fs.readFile(monthImagesMapPath, "utf8", (err, data) => {
    if (err) {
      if (err.code === "ENOENT") return callback(null, {});
      return callback(err);
    }
    try {
      const parsed = JSON.parse(data);
      callback(null, parsed && typeof parsed === "object" ? parsed : {});
    } catch (e) {
      callback(e);
    }
  });
}

function saveMonthImagesMap(map, callback) {
  fs.writeFile(monthImagesMapPath, JSON.stringify(map, null, 2), "utf8", callback);
}

function monthMapKey(yearNum, monthKeyRaw) {
  return `${yearNum}-${monthKeyRaw}`;
}

function uploadBufferCloudinary(buffer, options, callback) {
  const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
    if (err) return callback(err);
    if (!result || !result.secure_url) {
      return callback(new Error("Cloudinary upload returned no URL"));
    }
    callback(null, result);
  });
  stream.end(buffer);
}

function adminPassword() {
  return process.env.AVALON_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "";
}

function adminAuthConfigured() {
  const p = adminPassword();
  return typeof p === "string" && p.length > 0;
}

function adminUser() {
  return process.env.AVALON_ADMIN_USER || process.env.ADMIN_USER || "admin";
}

function checkAdminAuth(req, res) {
  if (!adminAuthConfigured()) return true;
  const auth = req.headers.authorization || "";
  const expectedUser = adminUser();
  const expectedPass = adminPassword();
  if (!auth.startsWith("Basic ")) {
    res.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Avalon Admin"'
    });
    res.end("Unauthorized");
    return false;
  }
  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
  } catch (_) {
    res.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Avalon Admin"'
    });
    res.end("Unauthorized");
    return false;
  }
  const sep = decoded.indexOf(":");
  const user = sep >= 0 ? decoded.slice(0, sep) : "";
  const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
  if (user !== expectedUser || pass !== expectedPass) {
    res.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Avalon Admin"'
    });
    res.end("Unauthorized");
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const rawPath = req.url.split("?")[0] || "/";
  const requestPath = rawPath.replace(/\/+$/, "") || "/";

  if (requestPath === "/") {
    const indexPath = path.join(publicDir, "index.html");
    return sendFile(res, indexPath, "text/html");
  }

  if (requestPath === "/admin") {
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
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

  if (requestPath === "/api/month-images" && req.method === "GET") {
    loadMonthImagesMap((err, map) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not read month images map" }));
        return;
      }
      const out = {};
      for (const [k, v] of Object.entries(map || {})) {
        if (typeof v === "string") out[k] = v;
        else if (v && typeof v.url === "string") out[k] = v.url;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (requestPath === "/api/live-config" && req.method === "POST") {
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing boundary" }));
      return;
    }

    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const bodyStr = buffer.toString("binary");
      const parts = bodyStr.split("--" + boundary);

      let fileContentBinary = null;
      let filename = null;
      let fields = {};

      for (const part of parts) {
        if (!part.includes("Content-Disposition")) continue;
        const [rawHeaders, rawBody] = part.split("\r\n\r\n");
        if (!rawBody) continue;
        const headers = rawHeaders.split("\r\n");
        const dispo = headers.find((h) => h.toLowerCase().startsWith("content-disposition"));
        if (!dispo) continue;

        const nameMatch = dispo.match(/name="([^"]+)"/);
        const fileMatch = dispo.match(/filename="([^"]*)"/);
        const fieldName = nameMatch ? nameMatch[1] : null;

        if (fileMatch && fieldName === "file") {
          filename = path.basename(fileMatch[1] || "episode.mp3");
          let fileSection = rawBody;
          fileSection = fileSection.replace(/\r\n--$/, "");
          fileContentBinary = fileSection;
        } else if (fieldName) {
          const value = rawBody.replace(/\r\n--$/, "").trim();
          fields[fieldName] = value;
        }
      }

      if (!filename || fileContentBinary == null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No file found in upload" }));
        return;
      }

      const fileBuffer = Buffer.from(fileContentBinary, "binary");

      function pushEpisodeAndRespond(audioUrl) {
        loadEpisodes((cfgErr, episodes) => {
          const list = cfgErr || !Array.isArray(episodes) ? [] : episodes.slice();
          const date = fields.date || new Date().toISOString().slice(0, 10);
          const title = fields.title || "Episode";
          const description = fields.description || "";
          const colorRaw = String(fields.color || "").toLowerCase();
          const allowedColors = ["red","orange","yellow","green","blue","indigo","violet"];
          const color = allowedColors.includes(colorRaw) ? colorRaw : "blue";

          list.push({ date, title, description, audioUrl, color });

          saveEpisodes(list, (saveErr) => {
            if (saveErr) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Could not update episodes" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ filename, audioUrl }));
          });
        });
      }

      if (cloudinary) {
        uploadBufferCloudinary(
          fileBuffer,
          {
            resource_type: "video",
            folder: "avalon/episodes",
            use_filename: true,
            unique_filename: true,
            filename_override: path.basename(filename)
          },
          (upErr, result) => {
            if (upErr) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: upErr.message || "Cloud upload failed" }));
              return;
            }
            pushEpisodeAndRespond(result.secure_url);
          }
        );
        return;
      }

      const targetPath = path.join(uploadsDir, filename);
      const audioUrl = "mp3/" + filename;

      fs.writeFile(targetPath, fileContentBinary, "binary", (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not save uploaded file" }));
          return;
        }
        pushEpisodeAndRespond(audioUrl);
      });
    });
    return;
  }

  if (requestPath === "/upload/month-image" && req.method === "POST") {
    if (!checkAdminAuth(req, res)) return;
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing boundary" }));
      return;
    }

    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const bodyStr = buffer.toString("binary");
      const parts = bodyStr.split("--" + boundary);

      let fileContentBinary = null;
      let fields = {};

      for (const part of parts) {
        if (!part.includes("Content-Disposition")) continue;
        const [rawHeaders, rawBody] = part.split("\r\n\r\n");
        if (!rawBody) continue;
        const headers = rawHeaders.split("\r\n");
        const dispo = headers.find((h) => h.toLowerCase().startsWith("content-disposition"));
        if (!dispo) continue;

        const nameMatch = dispo.match(/name="([^"]+)"/);
        const fileMatch = dispo.match(/filename="([^"]*)"/);
        const fieldName = nameMatch ? nameMatch[1] : null;

        if (fileMatch && fieldName === "file") {
          let fileSection = rawBody;
          fileSection = fileSection.replace(/\r\n--$/, "");
          fileContentBinary = fileSection;
        } else if (fieldName) {
          const value = rawBody.replace(/\r\n--$/, "").trim();
          fields[fieldName] = value;
        }
      }

      if (fileContentBinary == null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No file found in upload" }));
        return;
      }

      const monthKeyRaw = (fields.month || "").toLowerCase();
      const allowed = [
        "january","february","march","april","may","june",
        "july","august","september","october","november","december"
      ];
      if (!allowed.includes(monthKeyRaw)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid month" }));
        return;
      }

      const yearStr = (fields.year || "").trim();
      const yearNum = Number(yearStr);
      if (!yearStr || !Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 3000) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid year" }));
        return;
      }

      const targetName = `month-${yearNum}-${monthKeyRaw}.jpg`;
      const targetPath = path.join(imagesDir, targetName);
      const mapKey = monthMapKey(yearNum, monthKeyRaw);
      const fileBuffer = Buffer.from(fileContentBinary, "binary");

      function respondOk(extra) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            month: monthKeyRaw,
            year: yearNum,
            filename: targetName,
            ...(extra || {})
          })
        );
      }

      if (cloudinary) {
        const publicId = `month-${yearNum}-${monthKeyRaw}`;
        uploadBufferCloudinary(
          fileBuffer,
          {
            resource_type: "image",
            folder: "avalon/months",
            public_id: publicId,
            overwrite: true
          },
          (upErr, result) => {
            if (upErr) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: upErr.message || "Cloud upload failed" }));
              return;
            }
            loadMonthImagesMap((mapErr, map) => {
              const next = mapErr || !map || typeof map !== "object" ? {} : { ...map };
              next[mapKey] = {
                url: result.secure_url,
                publicId: result.public_id || publicId
              };
              saveMonthImagesMap(next, (saveErr) => {
                if (saveErr) {
                  res.writeHead(500, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Could not save month image map" }));
                  return;
                }
                respondOk({ imageUrl: result.secure_url });
              });
            });
          }
        );
        return;
      }

      fs.writeFile(targetPath, fileContentBinary, "binary", (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not save month image" }));
          return;
        }
        respondOk();
      });
    });
    return;
  }

  if (requestPath === "/api/delete-month-image" && req.method === "POST") {
    if (!checkAdminAuth(req, res)) return;
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
        const mapKey = monthMapKey(yearNum, monthKeyRaw);

        function removeLocalFile(done) {
          const resolved = path.resolve(targetPath);
          const resolvedImages = path.resolve(imagesDir);
          if (!resolved.startsWith(resolvedImages + path.sep)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid path" }));
            return;
          }
          fs.unlink(resolved, (err) => {
            if (err) {
              if (err.code === "ENOENT") return done(null, false);
              return done(err);
            }
            done(null, true);
          });
        }

        loadMonthImagesMap((mapErr, map) => {
          const safeMap = mapErr || !map || typeof map !== "object" ? {} : map;
          const entry = safeMap[mapKey];
          const cloudEntry = entry && typeof entry === "object" && entry.publicId;

          if (cloudinary && cloudEntry) {
            cloudinary.uploader.destroy(entry.publicId, { resource_type: "image" }, (destroyErr) => {
              if (destroyErr) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: destroyErr.message || "Could not delete cloud image" }));
                return;
              }
              delete safeMap[mapKey];
              saveMonthImagesMap(safeMap, (saveErr) => {
                if (saveErr) {
                  res.writeHead(500, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Could not update month image map" }));
                  return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, deleted: true }));
              });
            });
            return;
          }

          if (cloudinary && entry && typeof entry === "object" && entry.url && !entry.publicId) {
            delete safeMap[mapKey];
            saveMonthImagesMap(safeMap, (saveErr) => {
              if (saveErr) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Could not update month image map" }));
                return;
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, deleted: true }));
            });
            return;
          }

          removeLocalFile((unlinkErr, deleted) => {
            if (unlinkErr) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Could not delete month image" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, deleted }));
          });
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

