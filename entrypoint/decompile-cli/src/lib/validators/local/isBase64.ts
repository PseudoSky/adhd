const isBase64 = (v: string) => {
  console.log('Parser(Base64)');
  try {
    return !!Buffer.from(v, 'base64');
  } catch (e) {
    return false;
  }
};

export default isBase64;
