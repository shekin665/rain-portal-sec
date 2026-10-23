'use strict';
// Vercel entry point. Vercel serves public/ as static files and sends /api/* and /healthz here.
const { handle } = require('../server');
module.exports = (req, res) => handle(req, res);
