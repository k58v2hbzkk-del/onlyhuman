const wrap = require("./_adapter");
exports.handler = wrap(require("../../api/relay.js"));
