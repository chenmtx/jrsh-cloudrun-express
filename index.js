const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { init: initDB, User, Kitchen } = require('./db');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '30mb' }));
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

function makeDefaultKitchenName(nickname) {
  const displayName = String(nickname || '').trim() || '吃货玩家';
  return `${displayName}的厨房`;
}

function isLegacyDefaultKitchenName(name) {
  return !name || String(name).trim() === '用户xnhOS的厨房';
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

function isNumericKitchenId(id) {
  return /^\d{8}$/.test(String(id || ''));
}

async function makeNumericKitchenId() {
  for (let i = 0; i < 30; i += 1) {
    const id = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await Kitchen.findByPk(id) || await Kitchen.findOne({ where: { legacyId: id } });
    if (!existing) return id;
  }
  return String(Date.now()).slice(-8);
}

function getKitchenInfoWithId(rawInfo, kitchenId) {
  return {
    ...parseJson(rawInfo, {}),
    id: kitchenId
  };
}

async function migrateLegacyKitchen(kitchen) {
  if (!kitchen) return null;
  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;

  if (isNumericKitchenId(row.id)) {
    const kitchenInfo = getKitchenInfoWithId(row.kitchenInfo, row.id);
    if (parseJson(row.kitchenInfo, {}).id !== row.id) {
      await kitchen.update({
        kitchenInfo: stringifyJson(kitchenInfo, {})
      });
    }
    return kitchen;
  }

  const legacyId = row.id;
  const existing = await Kitchen.findOne({ where: { legacyId } });
  if (existing && existing.id !== legacyId) {
    const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const legacyTime = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    if (legacyTime > existingTime) {
      await existing.update({
        ownerUserId: row.ownerUserId,
        kitchenInfo: stringifyJson(getKitchenInfoWithId(row.kitchenInfo, existing.id), {}),
        categories: row.categories || stringifyJson(['未分类'], []),
        dishes: row.dishes || stringifyJson([], []),
        orders: row.orders || stringifyJson([], []),
        lastQueueCode: row.lastQueueCode || null
      });
    }
    await kitchen.destroy();
    return existing;
  }

  const numericId = await makeNumericKitchenId();
  try {
    const migrated = await Kitchen.create({
      id: numericId,
      legacyId,
      ownerUserId: row.ownerUserId,
      kitchenInfo: stringifyJson(getKitchenInfoWithId(row.kitchenInfo, numericId), {}),
      categories: row.categories || stringifyJson(['未分类'], []),
      dishes: row.dishes || stringifyJson([], []),
      orders: row.orders || stringifyJson([], []),
      lastQueueCode: row.lastQueueCode || null
    });
    await kitchen.destroy();
    return migrated;
  } catch (err) {
    const raced = await Kitchen.findOne({ where: { legacyId } });
    if (raced) return raced;
    throw err;
  }
}

async function findKitchenByIdOrLegacy(kitchenId) {
  const id = String(kitchenId || '').trim();
  if (!id) return null;

  const current = await Kitchen.findByPk(id);
  if (current) return migrateLegacyKitchen(current);

  const legacy = await Kitchen.findOne({ where: { legacyId: id } });
  if (legacy) return migrateLegacyKitchen(legacy);

  return null;
}

async function migrateLegacyUser(legacyUser, loginKey) {
  if (!legacyUser || isNumericUserId(legacyUser.id)) return legacyUser;

  const numericId = await makeNumericUserId();
  const migrated = await User.create({
    id: numericId,
    openid: loginKey,
    nickname: isBaseDefaultNickname(legacyUser.nickname) ? makeDefaultNickname() : legacyUser.nickname,
    avatar: legacyUser.avatar || ''
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
  const incomingAvatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
  const currentNickname = current && current.nickname;
  const currentAvatar = current && current.avatar;
  const nickname = isBaseDefaultNickname(incomingNickname)
    ? (isBaseDefaultNickname(currentNickname) ? makeDefaultNickname() : currentNickname)
    : incomingNickname;
  const next = {
    id: current ? current.id : await makeNumericUserId(),
    openid: loginKey,
    nickname,
    avatar: incomingAvatar || currentAvatar || ''
  };

  if (current) {
    await current.update(next);
    return current.toJSON();
  }

  const created = await User.create(next);
  return created.toJSON();
}

function normalizeKitchenState(kitchenId, ownerUserId, state = {}, options = {}) {
  const kitchenInfo = {
    ...(state.kitchenInfo || {}),
    id: kitchenId
  };

  if (isLegacyDefaultKitchenName(kitchenInfo.name)) {
    kitchenInfo.name = options.defaultKitchenName || makeDefaultKitchenName();
  }
  if (kitchenInfo.announcement === undefined) kitchenInfo.announcement = '欢迎光临本小店，祝您用餐愉快！';
  if (kitchenInfo.logo === undefined) kitchenInfo.logo = '';

  const payload = {
    id: kitchenId,
    ownerUserId,
    kitchenInfo: stringifyJson(kitchenInfo, {}),
    categories: stringifyJson(Array.isArray(state.categories) ? state.categories : ['未分类'], []),
    dishes: stringifyJson(Array.isArray(state.dishes) ? state.dishes : [], []),
    orders: stringifyJson(Array.isArray(state.orders) ? state.orders : [], []),
    lastQueueCode: state.lastQueueCode || null
  };

  if (Object.prototype.hasOwnProperty.call(options, 'legacyId')) {
    payload.legacyId = options.legacyId || null;
  }

  return payload;
}

async function ensureDefaultKitchenForUser(userId, state = {}, user = {}) {
  const defaultKitchenName = makeDefaultKitchenName(user.nickname);
  let kitchen = await Kitchen.findOne({
    where: { ownerUserId: userId },
    order: [['updatedAt', 'DESC']]
  });
  kitchen = await migrateLegacyKitchen(kitchen);
  if (kitchen) {
    const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
    const kitchenInfo = getKitchenInfoWithId(row.kitchenInfo, row.id);
    if (isLegacyDefaultKitchenName(kitchenInfo.name)) {
      kitchenInfo.name = defaultKitchenName;
      await kitchen.update({ kitchenInfo: stringifyJson(kitchenInfo, {}) });
    }
    return kitchen;
  }

  const localKitchenId = state.kitchenInfo && state.kitchenInfo.id;
  const kitchenId = isNumericKitchenId(localKitchenId) ? localKitchenId : await makeNumericKitchenId();
  const options = {
    ...(localKitchenId && localKitchenId !== kitchenId ? { legacyId: localKitchenId } : {}),
    defaultKitchenName
  };
  return Kitchen.create(normalizeKitchenState(kitchenId, userId, state, options));
}

function toClientState(kitchen) {
  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  const kitchenInfo = parseJson(row.kitchenInfo, { id: row.id, name: makeDefaultKitchenName() });
  return {
    kitchenId: row.id,
    ownerUserId: row.ownerUserId,
    kitchenInfo: {
      ...kitchenInfo,
      id: row.id
    },
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
  const body = req.body || {};
  const user = await upsertUser(req, body);
  const kitchen = await ensureDefaultKitchenForUser(user.id, body.localState || {}, user);
  res.send({ user, ...toClientState(kitchen) });
}));

app.post('/api/bootstrap', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const user = await upsertUser(req, body);
  const localState = body.localState || {};
  const requestedKitchenId = body.kitchenId || '';
  const ownerKitchen = await ensureDefaultKitchenForUser(
    user.id,
    requestedKitchenId ? {} : localState,
    user
  );
  let kitchen = requestedKitchenId ? await findKitchenByIdOrLegacy(requestedKitchenId) : ownerKitchen;

  if (!kitchen) {
    kitchen = ownerKitchen;
  }

  res.send({
    user,
    ...toClientState(kitchen)
  });
}));

app.get('/api/kitchens/:id/state', asyncHandler(async (req, res) => {
  const kitchen = await findKitchenByIdOrLegacy(req.params.id);
  if (!kitchen) {
    res.status(404).send({ error: 'Kitchen not found' });
    return;
  }

  res.send(toClientState(kitchen));
}));

app.post('/api/kitchens/:id/state', asyncHandler(async (req, res) => {
  const requestedKitchenId = req.params.id;
  const body = req.body || {};
  const current = await findKitchenByIdOrLegacy(requestedKitchenId);
  const kitchenId = current
    ? current.id
    : (isNumericKitchenId(requestedKitchenId) ? requestedKitchenId : await makeNumericKitchenId());
  const ownerUserId = current ? current.ownerUserId : (body.userId || getRequestUserId(req, body));
  const options = !current && requestedKitchenId && requestedKitchenId !== kitchenId
    ? { legacyId: requestedKitchenId }
    : {};
  const payload = normalizeKitchenState(kitchenId, ownerUserId, body.state || {}, options);

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
