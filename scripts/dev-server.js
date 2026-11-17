// Local stand-in for Vercel: serves web/ and runs api/*.js handlers.
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "web");
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, "");
    try { return await require(path.join(__dirname, "..", "api", name + ".js"))(req, res); }
    catch (e) { res.statusCode = 404; return res.end("no api"); }
  }
  let f = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f)) f = path.join(root, "index.html");
  res.setHeader("content-type", types[path.extname(f)] || "application/octet-stream");
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log("dev server on", process.env.PORT || 3000));
