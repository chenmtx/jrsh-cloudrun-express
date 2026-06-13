const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Op } = require('sequelize');
const { sequelize, init: initDB, User, Kitchen, Order, Dish } = require('./db');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '100mb' }));
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

function formatCabbageNumber(value, fallback = 2200.00) {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    const fallbackParsed = parseFloat(fallback);
    return Number.isNaN(fallbackParsed) ? 2200.00 : Number(fallbackParsed.toFixed(2));
  }
  return Number(parsed.toFixed(2));
}

function formatCabbageNumberText(value, fallback = 2200.00) {
  return formatCabbageNumber(value, fallback).toFixed(2);
}

function parseTransferAmount(value) {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Number(parsed.toFixed(2));
}

function makeCabbageTime(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function makeDefaultCabbageHistory(balance = 2200.00) {
  const formattedBalance = formatCabbageNumberText(balance);
  return [
    {
      id: makeId('hist'),
      type: 'add',
      amount: formattedBalance,
      desc: '注册赠送',
      time: makeCabbageTime(),
      balanceAfter: formattedBalance
    }
  ];
}

function normalizeCabbageHistory(history, balance = 2200.00) {
  const source = Array.isArray(history) ? history : parseJson(history, []);
  if (!Array.isArray(source) || source.length === 0) {
    return makeDefaultCabbageHistory(balance);
  }

  const normalized = source.reduce((result, item) => {
    if (!item || typeof item !== 'object') return result;

    result.push({
      id: item.id || makeId('hist'),
      type: item.type === 'sub' ? 'sub' : 'add',
      amount: formatCabbageNumberText(item.amount, 0),
      desc: typeof item.desc === 'string' ? item.desc : '',
      time: typeof item.time === 'string' && item.time ? item.time : makeCabbageTime(),
      balanceAfter: formatCabbageNumberText(item.balanceAfter, balance)
    });
    return result;
  }, []);

  return normalized.length > 0 ? normalized : makeDefaultCabbageHistory(balance);
}

function parseUserCabbageHistory(user, fallbackBalance = 2200.00) {
  if (!user) return makeDefaultCabbageHistory(fallbackBalance);
  return normalizeCabbageHistory(user.cabbageHistory, user.cabbageBalance !== undefined ? user.cabbageBalance : fallbackBalance);
}

function toClientUser(user) {
  const row = user && user.toJSON ? user.toJSON() : (user || {});
  const cabbageBalance = formatCabbageNumberText(row.cabbageBalance, 2200.00);
  return {
    ...row,
    cabbageBalance,
    cabbageHistory: parseUserCabbageHistory(row, cabbageBalance)
  };
}

function makeCabbageHistoryEntry(type, amount, desc, balanceAfter) {
  const normalizedAmount = formatCabbageNumberText(amount, 0);
  return {
    id: makeId('hist'),
    type: type === 'sub' ? 'sub' : 'add',
    amount: normalizedAmount,
    desc: typeof desc === 'string' ? desc : '',
    time: makeCabbageTime(),
    balanceAfter: formatCabbageNumberText(balanceAfter, 0)
  };
}

function extractTransferUserIdFromHistoryDesc(desc) {
  const text = typeof desc === 'string' ? desc.trim() : '';
  if (!text) return '';

  const patterns = [
    /^好友转赠给用户\(([^)]+)\)$/,
    /^好友转赠来自用户\(([^)]+)\)$/,
    /^大白菜转赠-给用户\(([^)]+)\)$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return String(match[1]).trim();
    }
  }
  return '';
}

function formatTransferHistoryDesc(desc, nickname) {
  const text = typeof desc === 'string' ? desc.trim() : '';
  const displayName = String(nickname || '').trim() || '好友';

  if (/^好友转赠给用户\([^)]+\)$/.test(text) || /^大白菜转赠-给用户\([^)]+\)$/.test(text)) {
    return `好友转赠给${displayName}`;
  }
  if (/^好友转赠来自用户\([^)]+\)$/.test(text)) {
    return `好友转赠来自${displayName}`;
  }
  return text;
}

async function decorateCabbageHistory(history) {
  const normalizedHistory = normalizeCabbageHistory(history);
  const relatedUserIds = Array.from(new Set(
    normalizedHistory
      .map(item => extractTransferUserIdFromHistoryDesc(item.desc))
      .filter(Boolean)
  ));

  if (!relatedUserIds.length) {
    return normalizedHistory;
  }

  const users = await User.findAll({
    attributes: ['id', 'nickname'],
    where: {
      id: {
        [Op.in]: relatedUserIds
      }
    }
  });

  const nicknameById = users.reduce((map, user) => {
    const row = user.toJSON ? user.toJSON() : user;
    map[String(row.id)] = row.nickname || '';
    return map;
  }, {});

  return normalizedHistory.map(item => {
    const relatedUserId = extractTransferUserIdFromHistoryDesc(item.desc);
    if (!relatedUserId) return item;
    return {
      ...item,
      desc: formatTransferHistoryDesc(item.desc, nicknameById[relatedUserId])
    };
  });
}

async function toClientUserWithDecoratedHistory(user) {
  const clientUser = toClientUser(user);
  return {
    ...clientUser,
    cabbageHistory: await decorateCabbageHistory(clientUser.cabbageHistory)
  };
}

function normalizeOrderQueueCode(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeOrderTotal(value) {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : Number(parsed.toFixed(2));
}

function parseOrderTimestamp(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const parsed = new Date(text.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeOrderList(orders) {
  const source = Array.isArray(orders) ? orders : parseJson(orders, []);
  if (!Array.isArray(source)) return [];

  const seenIds = new Set();
  return source.reduce((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const id = String(item.id || makeId('order'));
    if (seenIds.has(id)) return result;
    seenIds.add(id);
    result.push({
      ...item,
      id
    });
    return result;
  }, []);
}

function toOrderRow(kitchenId, kitchenOwnerUserId, order) {
  const normalized = {
    ...order,
    id: String(order.id || makeId('order'))
  };
  const time = typeof normalized.time === 'string' ? normalized.time.trim().slice(0, 32) : '';
  const timeFull = typeof normalized.timeFull === 'string' ? normalized.timeFull.trim().slice(0, 32) : '';

  // ownerUserId 应该是下单用户的ID，不是厨房主人的ID
  const ownerUserId = normalized.userId || normalized.ownerUserId || kitchenOwnerUserId;

  return {
    id: normalized.id,
    kitchenId: normalized.kitchenId || kitchenId,
    ownerUserId,
    status: typeof normalized.status === 'string' ? normalized.status.slice(0, 32) : '',
    queueCode: normalizeOrderQueueCode(normalized.queueCode),
    total: normalizeOrderTotal(normalized.total),
    time,
    timeFull,
    userNickname: typeof normalized.userNickname === 'string' ? normalized.userNickname.slice(0, 100) : '',
    orderedAt: parseOrderTimestamp(timeFull),
    payload: stringifyJson(normalized, {})
  };
}

function toClientOrder(order) {
  const row = order && order.toJSON ? order.toJSON() : (order || {});
  const payload = parseJson(row.payload, {});
  return {
    ...payload,
    id: row.id,
    kitchenId: payload.kitchenId !== undefined ? payload.kitchenId : row.kitchenId,
    ownerUserId: payload.ownerUserId !== undefined ? payload.ownerUserId : row.ownerUserId,
    userId: payload.userId !== undefined ? payload.userId : row.ownerUserId,
    status: payload.status !== undefined ? payload.status : (row.status || ''),
    queueCode: payload.queueCode !== undefined ? payload.queueCode : row.queueCode,
    total: payload.total !== undefined ? payload.total : row.total,
    time: payload.time !== undefined ? payload.time : (row.time || ''),
    timeFull: payload.timeFull !== undefined ? payload.timeFull : (row.timeFull || ''),
    userNickname: payload.userNickname !== undefined ? payload.userNickname : (row.userNickname || '')
  };
}

async function replaceKitchenOrders(kitchenId, ownerUserId, orders, options = {}) {
  const normalizedOrders = normalizeOrderList(orders);
  await sequelize.transaction(async transaction => {
    // 删除本次推送的订单ID（用于更新）
    const orderIds = normalizedOrders.map(o => o.id);
    if (orderIds.length > 0) {
      await Order.destroy({
        where: {
          id: { [Op.in]: orderIds }
        },
        transaction
      });
    }

    // 插入订单
    if (normalizedOrders.length > 0) {
      await Order.bulkCreate(
        normalizedOrders.map(order => toOrderRow(kitchenId, ownerUserId, order)),
        { transaction }
      );
    }

    // 更新Kitchen表的镜像字段（如果需要）
    if (options.updateKitchenMirror) {
      await Kitchen.update(
        { orders: stringifyJson(normalizedOrders, []) },
        {
          where: { id: kitchenId },
          transaction
        }
      );
    }
  });
  return normalizedOrders;
}

async function loadKitchenOrders(kitchen) {
  const row = kitchen && kitchen.toJSON ? kitchen.toJSON() : (kitchen || {});
  const legacyOrders = normalizeOrderList(row.orders);
  const query = {
    where: { kitchenId: row.id },
    order: [['orderedAt', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']]
  };
  let rows = await Order.findAll(query);
  if (rows.length === 0 && legacyOrders.length > 0) {
    await replaceKitchenOrders(row.id, row.ownerUserId, legacyOrders, { updateKitchenMirror: false });
    rows = await Order.findAll(query);
  }
  return rows.map(toClientOrder);
}

function toClientKitchenSummary(kitchen) {
  const row = kitchen && kitchen.toJSON ? kitchen.toJSON() : (kitchen || {});
  const info = parseJson(row.kitchenInfo, {});
  return {
    id: row.id,
    ownerUserId: row.ownerUserId || '',
    legacyId: row.legacyId || '',
    name: info.name || `厨房${row.id}`,
    logo: info.logo || ''
  };
}

async function loadOwnedKitchenOrders(kitchens) {
  const orderGroups = await Promise.all((kitchens || []).map(kitchen => loadKitchenOrders(kitchen)));
  return orderGroups.reduce((result, orders) => result.concat(orders), []);
}

function normalizeDishInteger(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDishPrice(value) {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : Number(parsed.toFixed(2));
}

function normalizeDishList(dishes) {
  const source = Array.isArray(dishes) ? dishes : parseJson(dishes, []);
  if (!Array.isArray(source)) return [];

  const seenIds = new Set();
  return source.reduce((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const rawId = item.id === undefined || item.id === null || item.id === ''
      ? makeId('dish')
      : item.id;
    const dishId = String(rawId);
    if (seenIds.has(dishId)) return result;
    seenIds.add(dishId);
    result.push({
      ...item,
      id: rawId
    });
    return result;
  }, []);
}

function hashKey(value) {
  let hash = 5381;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(index);
    hash &= 0x7fffffff;
  }
  return hash.toString(36);
}

function makeDishRowId(kitchenId, dishId) {
  const raw = `${kitchenId}:${dishId}`;
  if (raw.length <= 128) return raw;
  return `${String(kitchenId).slice(0, 48)}:${hashKey(raw)}:${String(dishId).slice(-48)}`;
}

function toDishRow(kitchenId, ownerUserId, dish, sortIndex = 0) {
  const dishId = String(dish.id);
  const name = typeof dish.name === 'string' && dish.name.trim()
    ? dish.name.trim().slice(0, 200)
    : '未命名菜谱';
  return {
    id: makeDishRowId(kitchenId, dishId),
    dishId,
    kitchenId,
    ownerUserId,
    category: typeof dish.category === 'string' ? dish.category.slice(0, 128) : '',
    name,
    price: normalizeDishPrice(dish.price),
    status: typeof dish.status === 'string' ? dish.status.slice(0, 32) : '',
    stars: normalizeDishInteger(dish.stars),
    stock: normalizeDishInteger(dish.stock),
    sales: normalizeDishInteger(dish.sales),
    sortIndex,
    payload: stringifyJson(dish, {})
  };
}

function toClientDish(dish) {
  const row = dish && dish.toJSON ? dish.toJSON() : (dish || {});
  const payload = parseJson(row.payload, {});
  return {
    ...payload,
    id: payload.id !== undefined ? payload.id : row.dishId,
    category: payload.category !== undefined ? payload.category : (row.category || ''),
    name: payload.name !== undefined ? payload.name : (row.name || ''),
    price: payload.price !== undefined ? payload.price : row.price,
    status: payload.status !== undefined ? payload.status : (row.status || ''),
    stars: payload.stars !== undefined ? payload.stars : row.stars,
    stock: payload.stock !== undefined ? payload.stock : row.stock,
    sales: payload.sales !== undefined ? payload.sales : row.sales
  };
}

async function replaceKitchenDishes(kitchenId, ownerUserId, dishes, options = {}) {
  const normalizedDishes = normalizeDishList(dishes);
  await sequelize.transaction(async transaction => {
    await Dish.destroy({
      where: { kitchenId },
      transaction
    });
    if (normalizedDishes.length > 0) {
      await Dish.bulkCreate(
        normalizedDishes.map((dish, index) => toDishRow(kitchenId, ownerUserId, dish, index)),
        { transaction }
      );
    }
    if (options.updateKitchenMirror) {
      await Kitchen.update(
        { dishes: stringifyJson(normalizedDishes, []) },
        {
          where: { id: kitchenId },
          transaction
        }
      );
    }
  });
  return normalizedDishes;
}

async function loadKitchenDishes(kitchen) {
  const row = kitchen && kitchen.toJSON ? kitchen.toJSON() : (kitchen || {});
  const legacyDishes = normalizeDishList(row.dishes);
  const query = {
    where: { kitchenId: row.id },
    order: [['sortIndex', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']]
  };
  let rows = await Dish.findAll(query);
  if (rows.length === 0 && legacyDishes.length > 0) {
    await replaceKitchenDishes(row.id, row.ownerUserId, legacyDishes, { updateKitchenMirror: false });
    rows = await Dish.findAll(query);
  }
  return rows.map(toClientDish);
}

async function restoreOrderInventoryIfNeeded(order) {
  if (!order || order.status !== 'cancelled' || order.inventoryRestored) return order;
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length || !order.kitchenId) return order;

  const quantityByDishId = items.reduce((result, item) => {
    const id = String(item && item.id !== undefined ? item.id : '').trim();
    if (!id) return result;
    result[id] = (result[id] || 0) + Number(item.count || 0);
    return result;
  }, {});

  const rows = await Dish.findAll({ where: { kitchenId: order.kitchenId } });
  await Promise.all(rows.map(row => {
    const currentDish = toClientDish(row);
    const count = quantityByDishId[String(currentDish.id || '')] || 0;
    if (!count) return Promise.resolve(null);

    const currentStock = currentDish.stock === undefined || currentDish.stock === null || currentDish.stock === ''
      ? 999
      : Number(currentDish.stock);
    const currentSales = Number(currentDish.sales || 0);
    const nextDish = {
      ...currentDish,
      stock: (Number.isNaN(currentStock) ? 0 : currentStock) + count,
      sales: Math.max(0, (Number.isNaN(currentSales) ? 0 : currentSales) - count)
    };
    const rowData = row.toJSON ? row.toJSON() : row;
    const nextRow = toDishRow(rowData.kitchenId, rowData.ownerUserId, nextDish, rowData.sortIndex || 0);
    return row.update({
      category: nextRow.category,
      name: nextRow.name,
      price: nextRow.price,
      status: nextRow.status,
      stars: nextRow.stars,
      stock: nextRow.stock,
      sales: nextRow.sales,
      payload: nextRow.payload
    });
  }));

  return {
    ...order,
    inventoryRestored: true
  };
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getRequestUserId(req, body = {}) {
  const debugUserId = body.debugUserId || req.headers['x-debug-user-id'];
  if (debugUserId) return String(debugUserId).trim();
  const wxOpenid = req.headers['x-wx-openid'];
  if (wxOpenid) return `wx_${wxOpenid}`;
  return body.clientUserId || body.userId || makeId('user');
}

function getDebugSwitchUserId(req, body = {}) {
  const raw = body.debugUserId || req.headers['x-debug-user-id'];
  return raw ? String(raw).trim() : '';
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
  const legacyOrders = normalizeOrderList(row.orders);
  const legacyDishes = normalizeDishList(row.dishes);

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
      await replaceKitchenOrders(existing.id, row.ownerUserId, legacyOrders, { updateKitchenMirror: false });
      await replaceKitchenDishes(existing.id, row.ownerUserId, legacyDishes, { updateKitchenMirror: false });
    }
    await Order.destroy({ where: { kitchenId: legacyId } });
    await Dish.destroy({ where: { kitchenId: legacyId } });
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
    await replaceKitchenOrders(numericId, row.ownerUserId, legacyOrders, { updateKitchenMirror: false });
    await replaceKitchenDishes(numericId, row.ownerUserId, legacyDishes, { updateKitchenMirror: false });
    await Order.destroy({ where: { kitchenId: legacyId } });
    await Dish.destroy({ where: { kitchenId: legacyId } });
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

  const cabbageBalance = legacyUser.cabbageBalance !== undefined ? legacyUser.cabbageBalance : 2200.00;
  const numericId = await makeNumericUserId();
  const migrated = await User.create({
    id: numericId,
    openid: loginKey,
    nickname: isBaseDefaultNickname(legacyUser.nickname) ? makeDefaultNickname() : legacyUser.nickname,
    avatar: legacyUser.avatar || '',
    defaultOrderNote: legacyUser.defaultOrderNote || '',
    cabbageBalance,
    cabbageHistory: stringifyJson(parseUserCabbageHistory(legacyUser, cabbageBalance), [])
  });

  await Kitchen.update(
    { ownerUserId: numericId },
    { where: { ownerUserId: legacyUser.id } }
  );
  await Order.update(
    { ownerUserId: numericId },
    { where: { ownerUserId: legacyUser.id } }
  );
  await Dish.update(
    { ownerUserId: numericId },
    { where: { ownerUserId: legacyUser.id } }
  );
  await legacyUser.destroy();

  return migrated;
}

async function upsertUser(req, body = {}) {
  const debugSwitchUserId = getDebugSwitchUserId(req, body);
  const loginKey = getRequestUserId(req, body);
  let current = null;

  if (debugSwitchUserId) {
    current = await User.findByPk(debugSwitchUserId);
    if (!current) {
      const err = new Error('Debug user not found');
      err.statusCode = 404;
      throw err;
    }
  } else {
    current = await User.findOne({ where: { openid: loginKey } });
    if (!current) {
      const legacyUser = await User.findByPk(loginKey);
      current = await migrateLegacyUser(legacyUser, loginKey);
    }
  }

  const incomingNickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const incomingAvatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
  const hasDefaultOrderNote = Object.prototype.hasOwnProperty.call(body, 'defaultOrderNote');
  const incomingDefaultOrderNote = hasDefaultOrderNote && typeof body.defaultOrderNote === 'string'
    ? body.defaultOrderNote.trim().slice(0, 300)
    : '';
  const currentNickname = current && current.nickname;
  const currentAvatar = current && current.avatar;
  const currentDefaultOrderNote = current && current.defaultOrderNote;
  const allowProfileMutation = !debugSwitchUserId;
  const nickname = allowProfileMutation
    ? (
        isBaseDefaultNickname(incomingNickname)
          ? (isBaseDefaultNickname(currentNickname) ? makeDefaultNickname() : currentNickname)
          : incomingNickname
      )
    : (currentNickname || makeDefaultNickname());
  const avatar = allowProfileMutation
    ? (incomingAvatar || currentAvatar || '')
    : (currentAvatar || '');
  const defaultOrderNote = allowProfileMutation
    ? (hasDefaultOrderNote ? incomingDefaultOrderNote : (currentDefaultOrderNote || ''))
    : (currentDefaultOrderNote || '');
  const hasCabbageBalance = Object.prototype.hasOwnProperty.call(body, 'cabbageBalance');
  const incomingCabbageBalance = hasCabbageBalance ? formatCabbageNumber(body.cabbageBalance, 2200.00) : 2200.00;
  const currentCabbageBalance = current && current.cabbageBalance;
  const incomingCabbageHistory = normalizeCabbageHistory(body.cabbageHistory, incomingCabbageBalance);
  const currentCabbageHistory = current ? parseUserCabbageHistory(current, currentCabbageBalance) : [];
  const persistedCabbageBalance = current ? formatCabbageNumber(currentCabbageBalance, 2200.00) : incomingCabbageBalance;
  const persistedCabbageHistory = current
    ? (currentCabbageHistory.length > 0 ? currentCabbageHistory : makeDefaultCabbageHistory(persistedCabbageBalance))
    : incomingCabbageHistory;

  const next = {
    id: current ? current.id : await makeNumericUserId(),
    // 调试切换用户只允许“借用会话”，不能改写用户原有的微信绑定标识，
    // 否则切回真实账号时会被后端误判成新用户并重复建号。
    openid: current
      ? (debugSwitchUserId ? (current.openid || null) : loginKey)
      : loginKey,
    nickname,
    avatar,
    defaultOrderNote,
    // Existing users treat the database as the source of truth for cabbage data.
    // Login/bootstrap must not overwrite remote balance with local default 2200 after cache clear.
    cabbageBalance: persistedCabbageBalance,
    cabbageHistory: stringifyJson(persistedCabbageHistory, [])
  };

  if (current) {
    await current.update(next);
    return toClientUser(current);
  }

  const created = await User.create(next);
  return toClientUser(created);
}

async function updateUserProfileById(userId, body = {}) {
  const current = await findUserByIdOrLoginKey(userId);
  if (!current) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const row = current.toJSON ? current.toJSON() : current;
  const incomingNickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const incomingAvatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
  const hasDefaultOrderNote = Object.prototype.hasOwnProperty.call(body, 'defaultOrderNote');
  const incomingDefaultOrderNote = hasDefaultOrderNote && typeof body.defaultOrderNote === 'string'
    ? body.defaultOrderNote.trim().slice(0, 300)
    : '';

  await current.update({
    nickname: incomingNickname || row.nickname || makeDefaultNickname(),
    avatar: incomingAvatar || '',
    defaultOrderNote: hasDefaultOrderNote ? incomingDefaultOrderNote : (row.defaultOrderNote || '')
  });

  return toClientUser(current);
}

async function findUserByIdOrLoginKey(id) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return null;

  const current = await User.findByPk(normalizedId);
  if (current) return current;

  return User.findOne({ where: { openid: normalizedId } });
}

function normalizeKitchenState(kitchenId, ownerUserId, state = {}, options = {}) {
  const normalizedOrders = normalizeOrderList(state.orders);
  const normalizedDishes = normalizeDishList(state.dishes);
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
    dishes: stringifyJson(normalizedDishes, []),
    orders: stringifyJson(normalizedOrders, []),
    lastQueueCode: state.lastQueueCode || null
  };

  if (Object.prototype.hasOwnProperty.call(options, 'legacyId')) {
    payload.legacyId = options.legacyId || null;
  }

  return {
    payload,
    orders: normalizedOrders,
    dishes: normalizedDishes
  };
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
  const normalizedState = normalizeKitchenState(kitchenId, userId, state, options);
  const createdKitchen = await Kitchen.create(normalizedState.payload);
  if (normalizedState.orders.length > 0) {
    await replaceKitchenOrders(kitchenId, userId, normalizedState.orders, { updateKitchenMirror: false });
  }
  if (normalizedState.dishes.length > 0) {
    await replaceKitchenDishes(kitchenId, userId, normalizedState.dishes, { updateKitchenMirror: false });
  }
  return createdKitchen;
}

async function toClientState(kitchen) {
  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  const kitchenInfo = parseJson(row.kitchenInfo, { id: row.id, name: makeDefaultKitchenName() });
  const orders = await loadKitchenOrders(row);
  const dishes = await loadKitchenDishes(row);
  return {
    kitchenId: row.id,
    ownerUserId: row.ownerUserId,
    kitchenInfo: {
      ...kitchenInfo,
      id: row.id
    },
    categories: parseJson(row.categories, []),
    dishes,
    orders,
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
  res.send({ user: toClientUser(user), ...(await toClientState(kitchen)) });
}));

app.post('/api/bootstrap', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const user = await upsertUser(req, body);
  const localState = body.localState || {};
  const requestedKitchenId = body.kitchenId || '';
  const strictKitchenId = !!body.strictKitchenId;
  const ownerKitchen = await ensureDefaultKitchenForUser(
    user.id,
    requestedKitchenId ? {} : localState,
    user
  );
  let kitchen = requestedKitchenId ? await findKitchenByIdOrLegacy(requestedKitchenId) : ownerKitchen;

  if (!kitchen && strictKitchenId) {
    res.status(404).send({
      ok: false,
      error: 'Kitchen not found',
      message: '厨房码不存在'
    });
    return;
  }

  if (!kitchen) {
    kitchen = ownerKitchen;
  }

  // 用户订单按下单用户筛选；自己的厨房订单由厨房归属决定。
  const userOrders = await Order.findAll({
    where: { ownerUserId: user.id },
    order: [['orderedAt', 'DESC'], ['createdAt', 'DESC'], ['id', 'DESC']]
  });
  const ownedKitchens = await Kitchen.findAll({
    where: { ownerUserId: user.id },
    order: [['updatedAt', 'DESC'], ['id', 'DESC']]
  });
  const ownKitchenOrders = await loadOwnedKitchenOrders(ownedKitchens.length ? ownedKitchens : [ownerKitchen]);

  res.send({
    user: toClientUser(user),
    ownerKitchenId: ownerKitchen.id,
    isVisitingKitchen: kitchen.id !== ownerKitchen.id,
    userOrders: userOrders.map(toClientOrder),
    ownKitchenOrders,
    ownedKitchens: (ownedKitchens.length ? ownedKitchens : [ownerKitchen]).map(toClientKitchenSummary),
    ...(await toClientState(kitchen))
  });
}));

app.post('/api/orders/:id', asyncHandler(async (req, res) => {
  const orderId = String(req.params.id || '').trim();
  const body = req.body || {};
  const incomingOrder = body.order || body;
  const current = await Order.findOne({ where: { id: orderId } });
  if (!current) {
    res.status(404).send({ error: 'Order not found' });
    return;
  }

  const row = current.toJSON ? current.toJSON() : current;
  let payload = {
    ...parseJson(row.payload, {}),
    ...incomingOrder,
    id: orderId,
    kitchenId: incomingOrder.kitchenId || row.kitchenId
  };
  payload = await restoreOrderInventoryIfNeeded(payload);
  const nextRow = toOrderRow(row.kitchenId, row.ownerUserId, payload);
  await current.update({
    kitchenId: nextRow.kitchenId,
    ownerUserId: nextRow.ownerUserId,
    status: nextRow.status,
    queueCode: nextRow.queueCode,
    total: nextRow.total,
    time: nextRow.time,
    timeFull: nextRow.timeFull,
    userNickname: nextRow.userNickname,
    orderedAt: nextRow.orderedAt,
    payload: nextRow.payload
  });
  await current.reload();
  res.send({ order: toClientOrder(current) });
}));

app.post('/api/users/:id/profile', asyncHandler(async (req, res) => {
  const user = await updateUserProfileById(req.params.id, req.body || {});
  res.send({
    ok: true,
    user: await toClientUserWithDecoratedHistory(user)
  });
}));

app.get('/api/users/:id/cabbage', asyncHandler(async (req, res) => {
  const user = await findUserByIdOrLoginKey(req.params.id);
  if (!user) {
    res.status(404).send({ error: 'User not found' });
    return;
  }

  const current = await toClientUserWithDecoratedHistory(user);
  res.send({
    userId: current.id,
    balance: current.cabbageBalance,
    history: current.cabbageHistory
  });
}));

app.post('/api/users/:id/cabbage', asyncHandler(async (req, res) => {
  const user = await findUserByIdOrLoginKey(req.params.id);
  if (!user) {
    res.status(404).send({ error: 'User not found' });
    return;
  }

  const body = req.body || {};
  const row = user.toJSON ? user.toJSON() : user;
  const currentBalance = formatCabbageNumber(row.cabbageBalance, 2200.00);
  const nextBalance = Object.prototype.hasOwnProperty.call(body, 'balance')
    ? formatCabbageNumber(body.balance, currentBalance)
    : currentBalance;
  const nextHistory = Object.prototype.hasOwnProperty.call(body, 'history')
    ? normalizeCabbageHistory(body.history, nextBalance)
    : parseUserCabbageHistory(row, nextBalance);

  await user.update({
    cabbageBalance: nextBalance,
    cabbageHistory: stringifyJson(nextHistory, [])
  });

  const decoratedHistory = await decorateCabbageHistory(nextHistory);
  res.send({
    userId: row.id,
    balance: formatCabbageNumberText(nextBalance),
    history: decoratedHistory
  });
}));

app.post('/api/cabbage/transfer', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const senderLoginKey = String(body.senderUserId || body.clientUserId || body.userId || getRequestUserId(req, body)).trim();
  const recipientUserId = String(body.toUserId || body.recipientUserId || body.transferCode || '').trim();
  const transferAmount = parseTransferAmount(body.amount);

  if (!recipientUserId) {
    res.status(400).send({ ok: false, error: 'Recipient required' });
    return;
  }
  if (transferAmount === null) {
    res.status(400).send({ ok: false, error: 'Invalid amount' });
    return;
  }

  const sender = await findUserByIdOrLoginKey(senderLoginKey);
  if (!sender) {
    res.status(404).send({ ok: false, error: 'Sender not found' });
    return;
  }

  const recipient = await findUserByIdOrLoginKey(recipientUserId);
  if (!recipient) {
    res.status(404).send({ ok: false, error: 'Recipient not found' });
    return;
  }

  const senderRow = sender.toJSON ? sender.toJSON() : sender;
  const recipientRow = recipient.toJSON ? recipient.toJSON() : recipient;
  if (String(senderRow.id) === String(recipientRow.id)) {
    res.status(400).send({ ok: false, error: 'Cannot transfer to self' });
    return;
  }

  const senderBalance = formatCabbageNumber(senderRow.cabbageBalance, 2200.00);
  const recipientBalance = formatCabbageNumber(recipientRow.cabbageBalance, 2200.00);
  if (senderBalance < transferAmount) {
    res.status(400).send({ ok: false, error: 'Insufficient balance' });
    return;
  }

  const nextSenderBalance = formatCabbageNumber(senderBalance - transferAmount, 0);
  const nextRecipientBalance = formatCabbageNumber(recipientBalance + transferAmount, 0);
  const senderName = String(senderRow.nickname || '').trim() || '好友';
  const recipientName = String(recipientRow.nickname || '').trim() || '好友';
  const senderDesc = typeof body.senderDesc === 'string' && body.senderDesc.trim()
    ? body.senderDesc.trim().slice(0, 160)
    : `好友转赠给${recipientName}`;
  const recipientDesc = typeof body.recipientDesc === 'string' && body.recipientDesc.trim()
    ? body.recipientDesc.trim().slice(0, 160)
    : `好友转赠来自${senderName}`;
  const nextSenderHistory = [
    makeCabbageHistoryEntry('sub', transferAmount, senderDesc, nextSenderBalance),
    ...parseUserCabbageHistory(senderRow, senderBalance)
  ];
  const nextRecipientHistory = [
    makeCabbageHistoryEntry('add', transferAmount, recipientDesc, nextRecipientBalance),
    ...parseUserCabbageHistory(recipientRow, recipientBalance)
  ];

  await sequelize.transaction(async transaction => {
    await sender.update({
      cabbageBalance: nextSenderBalance,
      cabbageHistory: stringifyJson(nextSenderHistory, [])
    }, { transaction });
    await recipient.update({
      cabbageBalance: nextRecipientBalance,
      cabbageHistory: stringifyJson(nextRecipientHistory, [])
    }, { transaction });
  });

  await sender.reload();
  await recipient.reload();

  res.send({
    ok: true,
    amount: formatCabbageNumberText(transferAmount, 0),
    sender: await toClientUserWithDecoratedHistory(sender),
    recipient: await toClientUserWithDecoratedHistory(recipient)
  });
}));

app.get('/api/kitchens/:id/state', asyncHandler(async (req, res) => {
  const kitchen = await findKitchenByIdOrLegacy(req.params.id);
  if (!kitchen) {
    res.status(404).send({ error: 'Kitchen not found' });
    return;
  }

  res.send(await toClientState(kitchen));
}));

app.get('/api/debug/session-switch-data', asyncHandler(async (req, res) => {
  const users = await User.findAll({
    attributes: ['id', 'openid', 'nickname', 'avatar', 'defaultOrderNote', 'cabbageBalance', 'updatedAt'],
    order: [['updatedAt', 'DESC']]
  });
  const kitchens = await Kitchen.findAll({
    attributes: ['id', 'ownerUserId', 'legacyId', 'kitchenInfo', 'updatedAt'],
    order: [['updatedAt', 'DESC']]
  });

  const kitchenCountByUserId = kitchens.reduce((map, kitchen) => {
    const ownerUserId = kitchen.ownerUserId || '';
    map[ownerUserId] = (map[ownerUserId] || 0) + 1;
    return map;
  }, {});

  res.send({
    users: users.map(user => {
      const row = user.toJSON ? user.toJSON() : user;
      return {
        id: row.id,
        openid: row.openid || '',
        nickname: row.nickname || '',
        avatar: row.avatar || '',
        defaultOrderNote: row.defaultOrderNote || '',
        cabbageBalance: formatCabbageNumberText(row.cabbageBalance, 2200.00),
        kitchenCount: kitchenCountByUserId[row.id] || 0,
        updatedAt: row.updatedAt || null
      };
    }),
    kitchens: kitchens.map(kitchen => ({
      ...toClientKitchenSummary(kitchen),
      announcement: parseJson((kitchen.toJSON ? kitchen.toJSON() : kitchen).kitchenInfo, {}).announcement || '',
      updatedAt: (kitchen.toJSON ? kitchen.toJSON() : kitchen).updatedAt || null
    }))
  });
}));

app.post('/api/kitchens/:id/catalog', asyncHandler(async (req, res) => {
  const requestedKitchenId = req.params.id;
  const body = req.body || {};
  const current = await findKitchenByIdOrLegacy(requestedKitchenId);
  const kitchenId = current
    ? current.id
    : (isNumericKitchenId(requestedKitchenId) ? requestedKitchenId : await makeNumericKitchenId());
  const ownerUserId = current ? current.ownerUserId : (body.userId || getRequestUserId(req, body));
  const categories = Array.isArray(body.categories) ? body.categories : ['未分类'];
  const dishes = normalizeDishList(body.dishes);

  if (current) {
    await current.update({
      categories: stringifyJson(categories, [])
    });
  } else {
    const options = requestedKitchenId && requestedKitchenId !== kitchenId
      ? { legacyId: requestedKitchenId }
      : {};
    const normalizedState = normalizeKitchenState(kitchenId, ownerUserId, {
      kitchenInfo: {
        id: kitchenId,
        name: makeDefaultKitchenName()
      },
      categories,
      dishes,
      orders: []
    }, options);
    await Kitchen.create(normalizedState.payload);
  }
  await replaceKitchenDishes(kitchenId, ownerUserId, dishes, { updateKitchenMirror: true });

  res.send({
    ok: true,
    kitchenId,
    dishCount: dishes.length,
    updatedAt: new Date().toISOString()
  });
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
  const normalizedState = normalizeKitchenState(kitchenId, ownerUserId, body.state || {}, options);

  let kitchen = current;
  if (kitchen) {
    await kitchen.update(normalizedState.payload);
  } else {
    kitchen = await Kitchen.create(normalizedState.payload);
  }
  await replaceKitchenOrders(kitchenId, ownerUserId, normalizedState.orders, { updateKitchenMirror: false });
  await replaceKitchenDishes(kitchenId, ownerUserId, normalizedState.dishes, { updateKitchenMirror: false });

  res.send(await toClientState(kitchen));
}));

app.use((err, req, res, next) => {
  console.error('接口执行失败', err);
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).send({
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
