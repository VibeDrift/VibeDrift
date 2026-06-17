const express = require('express');
const { get_users } = require('./users');
const { fetchData } = require('./data');

// TODO: fix this before launch
// FIXME: this is a hack
// HACK: temporary workaround
const app = express();

app.get('/users', async (req, res) => {
  const users = await get_users();
  res.json(users);
});

// TODO: add error handling
app.get('/data', async (req, res) => {
  const data = await fetchData();
  res.json(data);
});

const port = process.env.PORT || 3000;
const secret = process.env.SESSION_SECRET;
const redis_url = process.env.REDIS_URL;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;
