var util = require('util');
var net = require('net');
var stream = require('stream');

function IncomingMessage (parent) {
  stream.Stream.call(this);

  this.parent = parent;

  this._complete = false;

  this.httpVersion = null;
  this.headers = {};
  this.trailers = {};

  this.readable = true;

  // request (server) only
  this.url = "";
  this.method = null;

  // response (client) only
  this.statusCode = null;
}
util.inherits(IncomingMessage, stream.Stream);
exports.IncomingMessage = IncomingMessage;


IncomingMessage.prototype.destroy = function (error) {
  this.parent.destroy(error);
};


IncomingMessage.prototype.setEncoding = function (encoding) {
  var StringDecoder = require("string_decoder").StringDecoder; // lazy load
  this._decoder = new StringDecoder(encoding);
};

IncomingMessage.prototype.pause = function () {
  this.parent.pause();
};

IncomingMessage.prototype.resume = function () {
  this.parent.resume();
};

// Add the given (field, value) pair to the message
//
// Per RFC2616, section 4.2 it is acceptable to join multiple instances of the
// same header with a ', ' if the header in question supports specification of
// multiple values this way. If not, we declare the first instance the winner
// and drop the second. Extended header fields (those beginning with 'x-') are
// always joined.
IncomingMessage.prototype._addHeaderLine = function (field, value) {
  var dest;
  if (this._complete) {
      dest = this.trailers;
  } else {
      dest = this.headers;
  }
  switch (field) {
    // Array headers:
    case 'set-cookie':
      if (field in dest) {
        dest[field].push(value);
      } else {
        dest[field] = [value];
      }
      break;

    // Comma separate. Maybe make these arrays?
    case 'accept':
    case 'accept-charset':
    case 'accept-encoding':
    case 'accept-language':
    case 'connection':
    case 'cookie':
      if (field in dest) {
        dest[field] += ', ' + value;
      } else {
        dest[field] = value;
      }
      break;


    default:
      if (field.slice(0,2) == 'x-') {
        // except for x-
        if (field in dest) {
          dest[field] += ', ' + value;
        } else {
          dest[field] = value;
        }
      } else {
        // drop duplicates
        if (!(field in dest)) dest[field] = value;
      }
      break;
  }
};
