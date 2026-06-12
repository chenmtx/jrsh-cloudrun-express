const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { init: initDB, User, Kitchen } = require('./db');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '5mb' }));
app.use(cors());
app.use(morgan('tiny'));

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getRequestUserId(req, body = {}) {
  const wxOpenid = req.headers['x-wx-openid'];
  if (wxOpenid) return `wx_${wxOpenid}`;
  return body.clientUserId || body.userId || makeId('user');
}

function isBaseDefaultNickname(nickname) {
  return !nickname || String(nickname).trim() === '吃货玩家';
}

function makeDefaultNickname() {
  return `吃货玩家${Math.floor(1000 + Math.random() * 9000)}`;
}

function isNumericUserId(id) {
  return /^\d{8}$/.test(String(id || ''));
}

async function makeNumericUserId() {
  for (let i = 0; i < 30; i += 1) {
    const id = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await User.findByPk(id);
    if (!existing) return id;
  }
  return String(Date.now()).slice(-8);
}

async function migrateLegacyUser(legacyUser, loginKey) {
  if (!legacyUser || isNumericUserId(legacyUser.id)) return legacyUser;

  const numericId = await makeNumericUserId();
  const migrated = await User.create({
    id: numericId,
    openid: loginKey,
    nickname: isBaseDefaultNickname(legacyUser.nickname) ? makeDefaultNickname() : legacyUser.nickname,
    avatar: ''
  });

  await Kitchen.update(
    { ownerUserId: numericId },
    { where: { ownerUserId: legacyUser.id } }
  );
  await legacyUser.destroy();

  return migrated;
}

async function upsertUser(req, body = {}) {
  const loginKey = getRequestUserId(req, body);
  let current = await User.findOne({ where: { openid: loginKey } });
  if (!current) {
    const legacyUser = await User.findByPk(loginKey);
    current = await migrateLegacyUser(legacyUser, loginKey);
  }

  const incomingNickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const currentNickname = current && current.nickname;
  const nickname = isBaseDefaultNickname(incomingNickname)
    ? (isBaseDefaultNickname(currentNickname) ? makeDefaultNickname() : currentNickname)
    : incomingNickname;
  const next = {
    id: current ? current.id : await makeNumericUserId(),
    openid: loginKey,
    nickname,
    avatar: ''
  };

  if (current) {
    await current.update(next);
    return current.toJSON();
  }

  const created = await User.create(next);
  return created.toJSON();
}

function normalizeKitchenState(kitchenId, ownerUserId, state = {}) {
  const kitchenInfo = {
    ...(state.kitchenInfo || {}),
    id: kitchenId
  };

  if (!kitchenInfo.name) kitchenInfo.name = '用户xnhOS的厨房';
  if (kitchenInfo.announcement === undefined) kitchenInfo.announcement = '欢迎光临本小店，祝您用餐愉快！';
  if (kitchenInfo.logo === undefined) kitchenInfo.logo = '';

  return {
    id: kitchenId,
    ownerUserId,
    kitchenInfo: stringifyJson(kitchenInfo, {}),
    categories: stringifyJson(Array.isArray(state.categories) ? state.categories : ['未分类'], []),
    dishes: stringifyJson(Array.isArray(state.dishes) ? state.dishes : [], []),
    orders: stringifyJson(Array.isArray(state.orders) ? state.orders : [], []),
    lastQueueCode: state.lastQueueCode || null
  };
}

function toClientState(kitchen) {
  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  return {
    kitchenId: row.id,
    ownerUserId: row.ownerUserId,
    kitchenInfo: parseJson(row.kitchenInfo, { id: row.id, name: '用户xnhOS的厨房' }),
    categories: parseJson(row.categories, []),
    dishes: parseJson(row.dishes, []),
    orders: parseJson(row.orders, []),
    lastQueueCode: row.lastQueueCode || null,
    updatedAt: row.updatedAt
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.send({ ok: true, service: '今日食何云托管服务' });
});

app.post('/api/ping', (req, res) => {
  res.send({
    ok: true,
    body: req.body || {},
    openid: req.headers['x-wx-openid'] || ''
  });
});

app.post('/api/login', asyncHandler(async (req, res) => {
  const user = await upsertUser(req, req.body || {});
  res.send({ user });
}));

app.post('/api/bootstrap', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const user = await upsertUser(req, body);
  const localState = body.localState || {};
  const requestedKitchenId = body.kitchenId || '';
  let kitchen = requestedKitchenId ? await Kitchen.findByPk(requestedKitchenId) : null;

  if (!kitchen && !requestedKitchenId) {
    kitchen = await Kitchen.findOne({
      where: { ownerUserId: user.id },
      order: [['updatedAt', 'DESC']]
    });
  }

  if (!kitchen) {
    const localKitchenId = localState.kitchenInfo && localState.kitchenInfo.id;
    const kitchenId = requestedKitchenId || localKitchenId || makeId('kit');
    kitchen = await Kitchen.create(normalizeKitchenState(kitchenId, user.id, localState));
  }

  res.send({
    user,
    ...toClientState(kitchen)
  });
}));

app.get('/api/kitchens/:id/state', asyncHandler(async (req, res) => {
  const kitchen = await Kitchen.findByPk(req.params.id);
  if (!kitchen) {
    res.status(404).send({ error: 'Kitchen not found' });
    return;
  }

  res.send(toClientState(kitchen));
}));

app.post('/api/kitchens/:id/state', asyncHandler(async (req, res) => {
  const kitchenId = req.params.id;
  const body = req.body || {};
  const current = await Kitchen.findByPk(kitchenId);
  const ownerUserId = current ? current.ownerUserId : (body.userId || getRequestUserId(req, body));
  const payload = normalizeKitchenState(kitchenId, ownerUserId, body.state || {});

  let kitchen = current;
  if (kitchen) {
    await kitchen.update(payload);
  } else {
    kitchen = await Kitchen.create(payload);
  }

  res.send(toClientState(kitchen));
}));

app.use((err, req, res, next) => {
  console.error('接口执行失败', err);
  res.status(500).send({
    ok: false,
    error: err.name || 'Error',
    message: err.message || 'server error'
  });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log('启动成功', port);
  });
}

bootstrap().catch(err => {
  console.error('启动失败', err);
  process.exit(1);
});
