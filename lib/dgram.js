var sys = require("sys");
var fs = require("fs");
var events = require("events");
var dns = require('dns');

var Buffer = require('buffer').Buffer;
var IOWatcher   = process.IOWatcher;
var binding     = process.binding('net');
var socket      = binding.socket;
var bind        = binding.bind;
var recvfrom    = binding.recvfrom;
var sendto      = binding.sendto;
var close       = binding.close;

function isPort (x) { return parseInt(x) >= 0; }

function Socket (listener) {
  events.EventEmitter.call(this);
  var self = this;

  if (listener) {
    self.addListener('message', listener);
  }

  /* TODO: update */
  self.buf = new Buffer(1024 * 64);
  self.watcher = new IOWatcher();
  self.watcher.host = self;
  self.watcher.callback = function () {
    while (self.fd) {
      var rinfo = recvfrom(self.fd, self.buf, 0, self.buf.length, 0);

      if (!rinfo) return;

      self.emit('message', self.buf, rinfo);
    }
  };
}

sys.inherits(Socket, events.EventEmitter);
exports.Socket = Socket;

exports.createSocket = function (listener) {
  return new Socket(listener);
};

Socket.prototype.bind = function () {
  var self = this;
  if (self.fd) throw new Error('Server already opened');

  if (!isPort(arguments[0])) {
    /* TODO: unix path dgram */
    throw new Error('unix path dgrams are not supported yet');
  } else if (!arguments[1]) {
    // Don't bind(). OS will assign a port with INADDR_ANY.
    // The port can be found with server.address()
    self.type = 'udp4';
    self.fd = socket(self.type);
    bind(self.fd, arguments[0]);
    self._startWatcher();
  } else {
    // the first argument is the port, the second an IP
    var port = arguments[0];
    dns.lookup(arguments[1], function (err, ip, addressType) {
      if (err) {
        self.emit('error', err);
      } else {
        self.type = addressType == 4 ? 'udp4' : 'udp6';
        self.fd = socket(self.type);
        bind(self.fd, port, ip);
        self._startWatcher();
      }
    });
  }
};

Socket.prototype._startWatcher = function () {
  this.watcher.set(this.fd, true, false);
  this.watcher.start();
  this.emit("listening");
};

Socket.prototype.address = function () {
  return getsockname(this.fd);
};

Socket.prototype.send = function(port, addr, buffer, offset, length) {
  var self = this;

  dns.lookup(arguments[1], function (err, ip, addressType) {
    if (err) {
      self.emit('error', err);
    } else {
      if (!self.fd) {
        self.type = addressType == 4 ? 'udp4' : 'udp6';
        self.fd = socket(self.type);
        self._startWatcher();
      }
      sendto(self.fd, buffer, offset, length, 0, port, ip);
    }
  });
};

Socket.prototype.close = function () {
  var self = this;

  if (!self.fd) throw new Error('Not running');

  self.watcher.stop();

  close(self.fd);
  self.fd = null;

  if (self.type === "unix") {
    fs.unlink(self.path, function () {
      self.emit("close");
    });
  } else {
    self.emit("close");
  }
};
