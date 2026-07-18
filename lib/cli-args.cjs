function parseCliArgs(argv) {
  var result = {};
  for (var i = 0; i < argv.length; i += 1) {
    var token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;

    var key = token.slice(2);
    var next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    i += 1;
  }
  return result;
}

module.exports = {
  parseCliArgs: parseCliArgs,
};
