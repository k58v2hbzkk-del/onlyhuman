// Runs our Vercel-style (req, res) handlers inside Netlify Functions.
const { Readable } = require("stream");

module.exports = function wrap(handler) {
  return async (event) => {
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body)) : Buffer.alloc(0);
    const req = Readable.from(body.length ? [body] : []);
    req.method = event.httpMethod;
    req.headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    req.url = event.path;

    return await new Promise((resolve, reject) => {
      const headers = {};
      const res = {
        statusCode: 200,
        setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
        end: (data) => resolve({ statusCode: res.statusCode, headers, body: data ? String(data) : "" }),
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  };
};
