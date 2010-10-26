var httpserver = require('httpserver');
var httpcilent = require('httpclient');

exports.Server = httpserver.Server;

exports.createServer = function (requestListener) {
  return new httpserver.Server(requestListener);
};

exports.Client = httpclient.Client;

exports.createClient = function (port, host, https, credentials) {
  return new httpclient.Client(port, host, https, credentials);
};

exports.cat = function (url, encoding_, headers_) {
  var encoding = 'utf8',
      headers = {},
      callback = null;

  // parse the arguments for the various options... very ugly
  if (typeof(arguments[1]) == 'string') {
    encoding = arguments[1];
    if (typeof(arguments[2]) == 'object') {
      headers = arguments[2];
      if (typeof(arguments[3]) == 'function') callback = arguments[3];
    } else {
      if (typeof(arguments[2]) == 'function') callback = arguments[2];
    }
  } else {
    // didn't specify encoding
    if (typeof(arguments[1]) == 'object') {
      headers = arguments[1];
      callback = arguments[2];
    } else {
      callback = arguments[1];
    }
  }

  var url = require("url").parse(url);

  var hasHost = false;
  if (Array.isArray(headers)) {
    for (var i = 0, l = headers.length; i < l; i++) {
      if (headers[i][0].toLowerCase() === 'host') {
        hasHost = true;
        break;
      }
    }
  } else if (typeof headers === "Object") {
    var keys = Object.keys(headers);
    for (var i = 0, l = keys.length; i < l; i++) {
      var key = keys[i];
      if (key.toLowerCase() == 'host') {
        hasHost = true;
        break;
      }
    }
  }
  if (!hasHost) headers["Host"] = url.hostname;

  var content = "";

  var client = exports.createClient(url.port || 80, url.hostname);
  var req = client.request((url.pathname || "/")+(url.search || "")+(url.hash || ""), headers);

  if (url.protocol=="https:") {
      client.https = true;
  }

  var callbackSent = false;

  req.addListener('response', function (res) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      if (callback && !callbackSent) {
        callback(res.statusCode);
        callbackSent = true;
      }
      client.end();
      return;
    }
    res.setEncoding(encoding);
    res.addListener('data', function (chunk) { content += chunk; });
    res.addListener('end', function () {
      if (callback && !callbackSent) {
        callback(null, content);
        callbackSent = true;
      }
    });
  });

  client.addListener("error", function (err) {
    if (callback && !callbackSent) {
      callback(err);
      callbackSent = true;
    }
  });

  client.addListener("close", function () {
    if (callback && !callbackSent) {
      callback(new Error('Connection closed unexpectedly'));
      callbackSent = true;
    }
  });
  req.end();
};
