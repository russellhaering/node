

var fs = require('fs');
var Buffer = require('buffer').Buffer;

var path = "/tmp/wt.dat";
var tsize = 1000 * 1048576;
var bsizes = [1024, 4096, 8192, 16384, 32768, 65536];

function bufit(size) {
  var buf = new Buffer(size);
  for (var i = 0; i <buf.length ; i += 1) {
    buf[i] = 33;
  }
  return buf;
}

function once(emitter, name, cb) {
  function incb() {
    cb.apply(undefined, arguments);
    emitter.removeListener(name, incb);
  }
  emitter.addListener(name, incb);
}

function writetest(size, bsize) {
  var s = fs.createWriteStream(path, {'flags': 'w', 'encoding': 'binary', 'mode': 0644});
  var remaining = size;
  var buf = bufit(bsize);

  function dowrite() {
    var rv = s.write(buf, 'binary');
    if (rv === false) {
      once(s, 'drain', function() {
        dowrite();
      });
    }
    remaining -= buf.length;
    if (remaining > 0) {
      process.nextTick(dowrite);
    }
    else {
      s.emit('done')
      s.end();
    }
  }

  dowrite();

  return s;
}

function readtest(size, bsize) {
  var s = fs.createReadStream(path, {'flags': 'r', 'encoding': 'binary', 'mode': 0644, 'bufferSize': bsize});
  s.addListener("data", function (chunk) {
    // got a chunk...
    
  });
  return s;
}

function wt(tsize, bsize, done) {
  var start = Date.now();
  s = writetest(tsize, bsizes[0]);
  s.addListener('close', function() {
    var end = Date.now();
    var diff = end - start;
    console.log('Wrote '+ tsize +' bytes in '+  diff/1000 +'s using '+ bsize +' byte buffers: '+  ((tsize/(diff/1000)) / 1048576) +' mB/s');
    done();
  });
}

function rt(tsize, bsize, done) {
  var start = Date.now();
  s = readtest(tsize, bsizes[0]);
  s.addListener('close', function() {
    var end = Date.now();
    var diff = end - start;
    console.log('Read '+ tsize +' bytes in '+  diff/1000 +'s using '+ bsize +' byte buffers: '+  ((tsize/(diff/1000)) / 1048576) +' mB/s');
    done();
  });
}

var bs= 0;

function nextwt() {
  if (bsizes.length <= bs) {
    bs = 0;
    nextrt();
    return;
  }
  wt(tsize, bsizes[bs], nextwt);
  bs += 1;
}

function nextrt() {
  if (bsizes.length <= bs) {
    fs.unlink(path, function (err) {
      if (err) throw err;
      console.log('All done!');
    });
    return;
  }
  rt(tsize, bsizes[bs], nextrt);
  bs += 1;
}

nextwt();
