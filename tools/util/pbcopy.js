module.exports = function pbcopy(data) {
  let output = data;
  if (typeof data !== 'string') {
    output = JSON.stringify(data, null, 2);
  }
  var proc = require('child_process').spawn('pbcopy');
  proc.stdin.write(output);
  proc.stdin.end();
};
