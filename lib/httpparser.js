var FreeList = require('freelist').FreeList;
var HTTPParser = process.binding('http_parser').HTTPParser;
var httpincoming = require('httpincoming');

var parsers = new FreeList('parsers', 1000, function () {
  var parser = new HTTPParser('request');

  parser.onMessageBegin = function () {
    parser.incoming = new httpincoming.IncomingMessage(parser.socket);
    parser.field = null;
    parser.value = null;
  };

  // Only servers will get URL events.
  parser.onURL = function (b, start, len) {
    var slice = b.toString('ascii', start, start+len);
    if (parser.incoming.url) {
      parser.incoming.url += slice;
    } else {
      // Almost always will branch here.
      parser.incoming.url = slice;
    }
  };

  parser.onHeaderField = function (b, start, len) {
    var slice = b.toString('ascii', start, start+len).toLowerCase();
    if (parser.value !== null) {
      parser.incoming._addHeaderLine(parser.field, parser.value);
      parser.field = null;
      parser.value = null;
    }
    if (parser.field) {
      parser.field += slice;
    } else {
      parser.field = slice;
    }
  };

  parser.onHeaderValue = function (b, start, len) {
    var slice = b.toString('ascii', start, start+len);
    if (parser.value) {
      parser.value += slice;
    } else {
      parser.value = slice;
    }
  };

  parser.onHeadersComplete = function (info) {
    if (parser.field && (parser.value !== null)) {
      parser.incoming._addHeaderLine(parser.field, parser.value);
      parser.field = null;
      parser.value = null;
    }

    parser.incoming.httpVersionMajor = info.versionMajor;
    parser.incoming.httpVersionMinor = info.versionMinor;
    parser.incoming.httpVersion = info.versionMajor + '.' + info.versionMinor;

    if (info.method) {
      // server only
      parser.incoming.method = info.method;
    } else {
      // client only
      parser.incoming.statusCode = info.statusCode;  
    }

    parser.incoming.upgrade = info.upgrade;

    var isHeadResponse = false;

    if (!info.upgrade) {
      // For upgraded connections, we'll emit this after parser.execute
      // so that we can capture the first part of the new protocol
      isHeadResponse = parser.onIncoming(parser.incoming, info.shouldKeepAlive);
    }

    return isHeadResponse;
  };

  parser.onBody = function (b, start, len) {
    // TODO body encoding?
    var slice = b.slice(start, start+len);
    if (parser.incoming._decoder) {
      var string = parser.incoming._decoder.write(slice);
      if (string.length) {
        parser.incoming.emit('data', string);
      }
    } else {
      parser.incoming.emit('data', slice);
    }
  };

  parser.onMessageComplete = function () {
    this.incoming.complete = true;
    if (parser.field && (parser.value !== null)) {
      parser.incoming._addHeaderLine(parser.field, parser.value);
      parser.field = null;
      parser.value = null;
    }

    if (!parser.incoming.upgrade) {
      // For upgraded connections, also emit this after parser.execute
      parser.incoming.emit("end");
    }
  };

  return parser;
});

exports.parsers = parsers;

