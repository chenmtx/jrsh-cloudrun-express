const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Op } = require('sequelize');
const {
  sequelize,
  init: initDB,
  User,
  Kitchen,
  Order,
  Dish,
  LifeSharePost,
  LifeShareComment,
  LifeShareLike,
  LifeShareNotification
} = require('./db');

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

const DEFAULT_KITCHEN_DISPLAY_SETTINGS = {
  reviews: true,
  stock: false,
  sales: false,
  desc: true,
  stars: true,
  ingredients: true,
  steps: true,
  nutrition: true,
  cooking: true
};

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'false' || text === '0' || text === 'off') return false;
    if (text === 'true' || text === '1' || text === 'on') return true;
  }
  return !!value;
}

function normalizeBusinessTime(value, fallback) {
  const text = String(value || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(text)) return fallback;
  const parts = text.split(':');
  const hour = parseInt(parts[0], 10);
  const minute = parseInt(parts[1], 10);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeKitchenDisplaySettings(settings) {
  const source = typeof settings === 'string' ? parseJson(settings, {}) : (settings || {});
  return Object.keys(DEFAULT_KITCHEN_DISPLAY_SETTINGS).reduce((result, key) => {
    result[key] = normalizeBoolean(source[key], DEFAULT_KITCHEN_DISPLAY_SETTINGS[key]);
    return result;
  }, {});
}

function normalizeKitchenInfo(kitchenId, rawInfo = {}, row = {}) {
  const info = rawInfo && typeof rawInfo === 'object' ? rawInfo : {};
  const displaySettings = normalizeKitchenDisplaySettings(
    info.displaySettings !== undefined ? info.displaySettings : row.displaySettings
  );
  const album = Array.isArray(info.album)
    ? info.album.filter(image => typeof image === 'string' && image.trim()).slice(0, 4)
    : [];

  const normalized = {
    ...info,
    id: kitchenId,
    announcement: String(info.announcement !== undefined ? info.announcement : '欢迎光临本小店，祝您用餐愉快！').slice(0, 300),
    album,
    contact: String(info.contact || '').slice(0, 200),
    address: String(info.address || '').slice(0, 300),
    isPublic: normalizeBoolean(info.isPublic !== undefined ? info.isPublic : row.isPublic, false),
    businessOpen: normalizeBoolean(info.businessOpen !== undefined ? info.businessOpen : row.businessOpen, true),
    businessStart: normalizeBusinessTime(info.businessStart !== undefined ? info.businessStart : row.businessStart, '00:00'),
    businessEnd: normalizeBusinessTime(info.businessEnd !== undefined ? info.businessEnd : row.businessEnd, '23:59'),
    displaySettings
  };

  if (normalized.logo === undefined) normalized.logo = '';
  return normalized;
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

function normalizeCabbageHistory(history, balance = 2200.00, options = {}) {
  const source = Array.isArray(history) ? history : parseJson(history, []);
  if (!Array.isArray(source) || source.length === 0) {
    return options.keepEmpty ? [] : makeDefaultCabbageHistory(balance);
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

  return normalized.length > 0 ? normalized : (options.keepEmpty ? [] : makeDefaultCabbageHistory(balance));
}

function parseUserCabbageHistory(user, fallbackBalance = 2200.00) {
  if (!user) return makeDefaultCabbageHistory(fallbackBalance);
  const hasStoredHistory = user.cabbageHistory !== undefined
    && user.cabbageHistory !== null
    && String(user.cabbageHistory).trim() !== '';
  return normalizeCabbageHistory(
    user.cabbageHistory,
    user.cabbageBalance !== undefined ? user.cabbageBalance : fallbackBalance,
    { keepEmpty: hasStoredHistory }
  );
}

function toClientUser(user) {
  const row = user && user.toJSON ? user.toJSON() : (user || {});
  const cabbageBalance = formatCabbageNumberText(row.cabbageBalance, 2200.00);
  return {
    ...row,
    signState: ensureMonthlySignState(row),
    cabbageBalance,
    cabbageHistory: parseUserCabbageHistory(row, cabbageBalance)
  };
}

function formatDateTime(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date || Date.now());
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
}

function makeMonthlySignKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

const MONTHLY_SIGN_TASK_REWARDS = {
  7: 18888,
  15: 38888,
  30: 88888
};

function getMonthlySignReward(monthKey = makeMonthlySignKey(), dayIndex = 1) {
  const safeDay = Math.max(1, Math.min(30, Number(dayIndex) || 1));
  const text = `${String(monthKey || '').trim()}-${safeDay}`;
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) % 501;
  }
  return 1000 + seed;
}

function getMonthlySignAction(dayIndex = 1, signed = false, date = new Date()) {
  const safeDay = Math.max(1, Math.min(30, Number(dayIndex) || 1));
  const currentDay = Number(date && date.getDate ? date.getDate() : 0) || 0;
  if (signed) {
    return {
      canSign: false,
      canMakeUp: false
    };
  }
  return {
    canSign: currentDay >= 1 && currentDay <= 30 && safeDay === currentDay,
    canMakeUp: safeDay < currentDay
  };
}

function getCurrentMonthlySignDay(date = new Date()) {
  const day = Number(date && date.getDate ? date.getDate() : 0) || 0;
  return day >= 1 && day <= 30 ? day : 0;
}

function countSignedDays(signState = {}) {
  const days = signState && signState.days && typeof signState.days === 'object' ? signState.days : {};
  return Object.keys(days).reduce((count, key) => count + (days[key] && days[key].signed ? 1 : 0), 0);
}

function normalizeSignState(rawState = {}) {
  const state = typeof rawState === 'string'
    ? parseJson(rawState, {})
    : (rawState && typeof rawState === 'object' ? rawState : {});
  const monthKey = String(state.monthKey || '').trim();
  const dayItems = Array.isArray(state.days)
    ? state.days
    : Object.keys(state.days && typeof state.days === 'object' ? state.days : {}).map(key => {
        const item = state.days[key];
        if (item && typeof item === 'object') {
          return {
            ...item,
            day: item.day !== undefined ? item.day : key
          };
        }
        return { day: key };
      });
  const days = dayItems.reduce((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const day = Math.max(1, Math.min(30, Number(item.day) || 0));
    if (!day) return result;
    result[String(day)] = {
      day,
      reward: Number(item.reward) || getMonthlySignReward(monthKey, day),
      signed: !!item.signed,
      signedAt: String(item.signedAt || ''),
      canSign: !!item.canSign,
      canMakeUp: !!item.canMakeUp
    };
    return result;
  }, {});
  const normalized = {
    monthKey,
    days,
    makeUpLogs: (Array.isArray(state.makeUpLogs) ? state.makeUpLogs : [])
      .map(log => ({
        day: Math.max(1, Math.min(30, Number(log && log.day) || 0)),
        signedAt: String((log && log.signedAt) || ''),
        cost: formatCabbageNumberText(log && log.cost, 0),
        reward: formatCabbageNumberText(log && log.reward, 0)
      }))
      .filter(log => log.day && log.signedAt)
  };
  normalized.claimedRewards = Object.keys(MONTHLY_SIGN_TASK_REWARDS).reduce((result, key) => {
    const item = state.claimedRewards && typeof state.claimedRewards === 'object' ? state.claimedRewards[key] : null;
    result[String(key)] = {
      milestone: Number(key),
      claimed: !!(item && item.claimed),
      claimedAt: String((item && item.claimedAt) || ''),
      reward: formatCabbageNumberText((item && item.reward) || MONTHLY_SIGN_TASK_REWARDS[key], 0)
    };
    return result;
  }, {});
  return normalized;
}

function buildDefaultMonthlySignState(monthKey = makeMonthlySignKey()) {
  const days = {};
  for (let i = 1; i <= 30; i += 1) {
    const action = getMonthlySignAction(i, false);
    days[String(i)] = {
      day: i,
      reward: getMonthlySignReward(monthKey, i),
      signed: false,
      signedAt: '',
      canSign: action.canSign,
      canMakeUp: action.canMakeUp
    };
  }
  return {
    monthKey,
    days,
    makeUpLogs: [],
    claimedRewards: Object.keys(MONTHLY_SIGN_TASK_REWARDS).reduce((result, key) => {
      result[String(key)] = {
        milestone: Number(key),
        claimed: false,
        claimedAt: '',
        reward: formatCabbageNumberText(MONTHLY_SIGN_TASK_REWARDS[key], 0)
      };
      return result;
    }, {})
  };
}

function ensureMonthlySignState(user) {
  const row = user && user.toJSON ? user.toJSON() : (user || {});
  const currentMonthKey = makeMonthlySignKey();
  const normalized = normalizeSignState(row.signState);
  const sourceDays = normalized.monthKey === currentMonthKey ? normalized.days : {};
  const makeUpLogs = normalized.monthKey === currentMonthKey ? normalized.makeUpLogs : [];
  const claimedRewards = normalized.monthKey === currentMonthKey ? normalized.claimedRewards : {};
  const days = {};
  for (let i = 1; i <= 30; i += 1) {
    const key = String(i);
    const existing = sourceDays[key] || {};
    const signed = !!existing.signed;
    const action = getMonthlySignAction(i, signed);
    days[key] = {
      day: i,
      reward: Number(existing.reward) || getMonthlySignReward(currentMonthKey, i),
      signed,
      signedAt: String(existing.signedAt || ''),
      canSign: action.canSign,
      canMakeUp: action.canMakeUp
    };
  }

  return {
    monthKey: currentMonthKey,
    days,
    makeUpLogs,
    claimedRewards: Object.keys(MONTHLY_SIGN_TASK_REWARDS).reduce((result, key) => {
      const item = claimedRewards && claimedRewards[key] ? claimedRewards[key] : {};
      result[String(key)] = {
        milestone: Number(key),
        claimed: !!item.claimed,
        claimedAt: String(item.claimedAt || ''),
        reward: formatCabbageNumberText(item.reward || MONTHLY_SIGN_TASK_REWARDS[key], 0)
      };
      return result;
    }, {})
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

function isLegacySoftDeletedOrderPayload(payload = {}) {
  const deletedForUserIds = Array.isArray(payload.deletedForUserIds)
    ? payload.deletedForUserIds.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  return !!payload.deletedForMerchant || deletedForUserIds.length > 0;
}

async function cleanupLegacySoftDeletedOrders() {
  const orderRows = await Order.findAll({
    attributes: ['id', 'kitchenId', 'payload']
  });
  const deletedOrderIds = orderRows.reduce((result, order) => {
    const row = order && order.toJSON ? order.toJSON() : order;
    const payload = parseJson(row.payload, {});
    if (isLegacySoftDeletedOrderPayload(payload)) {
      result.push(String(row.id || '').trim());
    }
    return result;
  }, []).filter(Boolean);

  if (!deletedOrderIds.length) {
    return {
      deletedOrders: 0,
      updatedKitchens: 0
    };
  }

  const deletedOrderIdSet = new Set(deletedOrderIds);
  const kitchenRows = await Kitchen.findAll({
    attributes: ['id', 'orders']
  });
  const kitchensToUpdate = kitchenRows.reduce((result, kitchen) => {
    const row = kitchen && kitchen.toJSON ? kitchen.toJSON() : kitchen;
    const currentOrders = normalizeOrderList(row.orders);
    const nextOrders = currentOrders.filter(item => !deletedOrderIdSet.has(String(item && item.id || '').trim()));
    if (nextOrders.length === currentOrders.length) return result;
    result.push({ kitchen, nextOrders });
    return result;
  }, []);

  await sequelize.transaction(async transaction => {
    if (deletedOrderIds.length > 0) {
      await Order.destroy({
        where: {
          id: {
            [Op.in]: deletedOrderIds
          }
        },
        transaction
      });
    }

    for (const item of kitchensToUpdate) {
      await item.kitchen.update({
        orders: stringifyJson(item.nextOrders, [])
      }, { transaction });
    }
  });

  return {
    deletedOrders: deletedOrderIds.length,
    updatedKitchens: kitchensToUpdate.length
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

function calculateBusinessDays(value) {
  const startTime = new Date(value || '').getTime();
  if (!Number.isFinite(startTime)) return 0;
  const elapsedMs = Date.now() - startTime;
  if (elapsedMs < 0) return 1;
  return Math.max(1, Math.floor(elapsedMs / 86400000) + 1);
}

async function getKitchenDishCount(row) {
  const dishCount = await Dish.count({ where: { kitchenId: row.id } });
  if (dishCount > 0) return dishCount;
  return normalizeDishList(row.dishes).length;
}

function getKitchenCategoryList(row, dishes = []) {
  const rawCategories = parseJson(row && row.categories, []);
  const categories = Array.isArray(rawCategories) ? rawCategories : [];
  const result = [];
  const seen = new Set();

  categories.concat((dishes || []).map(dish => dish && dish.category)).forEach(category => {
    const text = String(category || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });

  return result.length > 0 ? result : ['未分类'];
}

function mergeKitchenCategories(targetCategories = [], sourceCategories = []) {
  const result = [];
  const seen = new Set();
  targetCategories.concat(sourceCategories).forEach(category => {
    const text = String(category || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result.length > 0 ? result : ['未分类'];
}

function cloneDishForKitchen(dish) {
  return {
    ...(dish || {}),
    id: makeId('dish'),
    stock: 999,
    limit: '',
    status: 'available',
    isPublic: false,
    isRequired: false,
    sales: 0
  };
}

function makeStolenDishKey(sourceKitchenId, sourceDishId) {
  return `${String(sourceKitchenId || '').trim()}::${String(sourceDishId || '').trim()}`;
}

function normalizeStolenDishRecords(records) {
  const source = Array.isArray(records) ? records : [];
  const seen = new Set();
  return source.reduce((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const sourceKitchenId = String(item.sourceKitchenId || '').trim();
    const sourceDishId = String(item.sourceDishId || '').trim();
    if (!sourceKitchenId || !sourceDishId) return result;
    const key = makeStolenDishKey(sourceKitchenId, sourceDishId);
    if (seen.has(key)) return result;
    seen.add(key);
    result.push({
      id: item.id || makeId('steal'),
      sourceKitchenId,
      sourceDishId,
      targetDishId: String(item.targetDishId || '').trim(),
      sourceKitchenName: String(item.sourceKitchenName || '').trim(),
      dishName: String(item.dishName || '').trim(),
      targetCategory: String(item.targetCategory || '未分类').trim() || '未分类',
      cost: formatCabbageNumberText(item.cost, 200),
      compensation: formatCabbageNumberText(item.compensation, 100),
      stolenAt: String(item.stolenAt || new Date().toISOString())
    });
    return result;
  }, []);
}

function buildStolenDishCountMap(kitchens = []) {
  return (Array.isArray(kitchens) ? kitchens : []).reduce((result, kitchen) => {
    const row = kitchen && kitchen.toJSON ? kitchen.toJSON() : (kitchen || {});
    const info = parseJson(row.kitchenInfo, {});
    const stolenRecords = normalizeStolenDishRecords(info.stolenDishes);
    stolenRecords.forEach(record => {
      const key = makeStolenDishKey(record.sourceKitchenId, record.sourceDishId);
      result[key] = (result[key] || 0) + 1;
    });
    return result;
  }, {});
}

function stealDishForKitchen(dish, targetCategory, meta = {}) {
  const sourceDishId = String(dish && dish.id !== undefined ? dish.id : '').trim();
  return {
    ...(dish || {}),
    id: meta.targetDishId || makeId('dish'),
    category: targetCategory || '未分类',
    stock: 999,
    limit: '',
    status: 'available',
    isPublic: false,
    isRequired: false,
    sales: 0,
    sourceType: 'steal',
    sourceKitchenId: String(meta.sourceKitchenId || '').trim(),
    sourceDishId,
    sourceKitchenName: String(meta.sourceKitchenName || '').trim(),
    stolenAt: meta.stolenAt || new Date().toISOString()
  };
}

function calculateKitchenRecommendationScore({ info = {}, dishCount = 0, categories = [], dishes = [], updatedAt = null }) {
  const safeDishCount = Math.max(0, Number(dishCount || 0));
  const dishScore = Math.min(safeDishCount, 20) / 20 * 50;
  const hasName = !!String(info.name || '').trim();
  const hasAnnouncement = !!String(info.announcement || '').trim();
  const imageDishCount = (Array.isArray(dishes) ? dishes : []).filter(dish => dish && dish.image).length;
  const imageRatio = safeDishCount > 0 ? Math.min(imageDishCount / safeDishCount, 1) : 0;
  const completenessScore = [
    info.bgImage ? 8 : 0,
    info.logo ? 5 : 0,
    hasName ? 4 : 0,
    hasAnnouncement ? 4 : 0,
    Array.isArray(categories) && categories.length > 0 ? 4 : 0,
    imageRatio * 5
  ].reduce((sum, value) => sum + value, 0);
  const updatedTime = new Date(updatedAt || 0).getTime();
  const elapsedDays = Number.isFinite(updatedTime)
    ? (Date.now() - updatedTime) / 86400000
    : Infinity;
  const activeScore = elapsedDays <= 7 ? 20 : (elapsedDays <= 30 ? 10 : 0);
  return Number((dishScore + completenessScore + activeScore).toFixed(2));
}

function compareKitchenRecommendation(left, right) {
  const leftHasDish = Number(left && left.dishCount || 0) > 0 ? 1 : 0;
  const rightHasDish = Number(right && right.dishCount || 0) > 0 ? 1 : 0;
  if (leftHasDish !== rightHasDish) return rightHasDish - leftHasDish;

  const scoreDiff = Number(right && right.recommendationScore || 0) - Number(left && left.recommendationScore || 0);
  if (scoreDiff !== 0) return scoreDiff;

  const leftTime = new Date(left && left.updatedAt || 0).getTime();
  const rightTime = new Date(right && right.updatedAt || 0).getTime();
  return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
}

async function toClientKitchenSummary(kitchen) {
  const row = kitchen && kitchen.toJSON ? kitchen.toJSON() : (kitchen || {});
  const info = normalizeKitchenInfo(row.id, parseJson(row.kitchenInfo, {}), row);
  const kitchenCode = await ensureKitchenCode(kitchen);
  const createdAt = row.createdAt || null;
  const dishes = normalizeDishList(row.dishes);
  const categories = getKitchenCategoryList(row, dishes);
  const dishCount = await getKitchenDishCount(row);
  const updatedAt = row.updatedAt || null;
  return {
    id: row.id,
    ownerUserId: row.ownerUserId || '',
    legacyId: row.legacyId || '',
    kitchenCode,
    name: info.name || `厨房${row.id}`,
    logo: info.logo || '',
    bgImage: info.bgImage || '',
    dishCount,
    businessDays: calculateBusinessDays(createdAt),
    isPublic: !!info.isPublic,
    businessOpen: !!info.businessOpen,
    businessStart: info.businessStart,
    businessEnd: info.businessEnd,
    displaySettings: info.displaySettings,
    createdAt,
    updatedAt,
    recommendationScore: calculateKitchenRecommendationScore({
      info,
      dishCount,
      categories,
      dishes,
      updatedAt
    })
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
    const existing = await Kitchen.findByPk(id)
      || await Kitchen.findOne({ where: { legacyId: id } })
      || await Kitchen.findOne({ where: { kitchenCode: id } });
    if (!existing) return id;
  }
  return String(Date.now()).slice(-8);
}

function isKitchenCode(value) {
  return /^\d{6}$/.test(String(value || '').trim());
}

async function isKitchenCodeAvailable(code, currentKitchenId = '', allowedKitchenIds = []) {
  if (!isKitchenCode(code)) return false;
  const allowedIds = new Set(
    [currentKitchenId].concat(allowedKitchenIds)
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  const matches = await Promise.all([
    Kitchen.findOne({ where: { kitchenCode: code } }),
    Kitchen.findByPk(code),
    Kitchen.findOne({ where: { legacyId: code } })
  ]);
  return matches.every(kitchen => !kitchen || allowedIds.has(String(kitchen.id || '')));
}

async function makeKitchenCode(preferredCode = '', currentKitchenId = '', allowedKitchenIds = []) {
  const preferred = String(preferredCode || '').trim();
  if (await isKitchenCodeAvailable(preferred, currentKitchenId, allowedKitchenIds)) return preferred;

  for (let i = 0; i < 80; i += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (await isKitchenCodeAvailable(code, currentKitchenId, allowedKitchenIds)) return code;
  }

  for (let i = 0; i < 80; i += 1) {
    const code = String(Date.now() + i).slice(-6);
    if (await isKitchenCodeAvailable(code, currentKitchenId, allowedKitchenIds)) return code;
  }

  throw new Error('Unable to allocate kitchen code');
}

function getKitchenInfoWithId(rawInfo, kitchenId) {
  return {
    ...parseJson(rawInfo, {}),
    id: kitchenId
  };
}

async function ensureKitchenCode(kitchen, allowedKitchenIds = []) {
  if (!kitchen) return '';
  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  const rawInfo = parseJson(row.kitchenInfo, {});
  const preferred = isKitchenCode(row.kitchenCode)
    ? row.kitchenCode
    : (isKitchenCode(row.legacyId)
        ? row.legacyId
        : (isKitchenCode(rawInfo.kitchenCode) ? rawInfo.kitchenCode : (isKitchenCode(row.id) ? row.id : '')));
  const kitchenCode = await makeKitchenCode(preferred, row.id, allowedKitchenIds);
  const nextInfo = {
    ...rawInfo,
    id: row.id,
    legacyId: row.legacyId || '',
    kitchenCode
  };
  const updates = {};

  if (row.kitchenCode !== kitchenCode) {
    updates.kitchenCode = kitchenCode;
  }
  if (rawInfo.id !== row.id || rawInfo.legacyId !== nextInfo.legacyId || rawInfo.kitchenCode !== kitchenCode) {
    updates.kitchenInfo = stringifyJson(nextInfo, {});
  }

  if (Object.keys(updates).length > 0 && kitchen.update) {
    await kitchen.update(updates);
  }

  return kitchenCode;
}

async function migrateLegacyKitchen(kitchen) {
  if (!kitchen) return null;
  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  const legacyOrders = normalizeOrderList(row.orders);
  const legacyDishes = normalizeDishList(row.dishes);

  if (isNumericKitchenId(row.id)) {
    const kitchenCode = await ensureKitchenCode(kitchen);
    const kitchenInfo = getKitchenInfoWithId(row.kitchenInfo, row.id);
    kitchenInfo.legacyId = row.legacyId || '';
    kitchenInfo.kitchenCode = kitchenCode;
    const rawInfo = parseJson(row.kitchenInfo, {});
    if (rawInfo.id !== row.id || rawInfo.legacyId !== kitchenInfo.legacyId || rawInfo.kitchenCode !== kitchenCode) {
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
        kitchenInfo: stringifyJson({
          ...getKitchenInfoWithId(row.kitchenInfo, existing.id),
          legacyId: existing.legacyId || legacyId,
          kitchenCode: existing.kitchenCode || (isKitchenCode(legacyId) ? legacyId : '')
        }, {}),
        categories: row.categories || stringifyJson(['未分类'], []),
        dishes: row.dishes || stringifyJson([], []),
        orders: row.orders || stringifyJson([], []),
        lastQueueCode: row.lastQueueCode || null
      });
      await ensureKitchenCode(existing, [legacyId]);
      await replaceKitchenOrders(existing.id, row.ownerUserId, legacyOrders, { updateKitchenMirror: false });
      await replaceKitchenDishes(existing.id, row.ownerUserId, legacyDishes, { updateKitchenMirror: false });
    }
    await ensureKitchenCode(existing, [legacyId]);
    await Order.destroy({ where: { kitchenId: legacyId } });
    await Dish.destroy({ where: { kitchenId: legacyId } });
    await kitchen.destroy();
    return existing;
  }

  const numericId = await makeNumericKitchenId();
  const kitchenCode = await makeKitchenCode(legacyId, numericId, [legacyId]);
  try {
    const migrated = await Kitchen.create({
      id: numericId,
      legacyId,
      kitchenCode,
      ownerUserId: row.ownerUserId,
      kitchenInfo: stringifyJson({
        ...getKitchenInfoWithId(row.kitchenInfo, numericId),
        legacyId,
        kitchenCode
      }, {}),
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

  const current = await Kitchen.findOne({ where: { id, dissolvedAt: null } });
  if (current) return migrateLegacyKitchen(current);

  const byKitchenCode = await Kitchen.findOne({ where: { kitchenCode: id, dissolvedAt: null } });
  if (byKitchenCode) return migrateLegacyKitchen(byKitchenCode);

  const legacy = await Kitchen.findOne({ where: { legacyId: id, dissolvedAt: null } });
  if (legacy) return migrateLegacyKitchen(legacy);

  return null;
}

async function migrateLegacyUser(legacyUser, loginKey) {
  if (!legacyUser || isNumericUserId(legacyUser.id)) return legacyUser;

  const cabbageBalance = legacyUser.cabbageBalance !== undefined ? legacyUser.cabbageBalance : 2200.00;
  const signState = ensureMonthlySignState(legacyUser);
  const numericId = await makeNumericUserId();
  const migrated = await User.create({
    id: numericId,
    openid: loginKey,
    nickname: isBaseDefaultNickname(legacyUser.nickname) ? makeDefaultNickname() : legacyUser.nickname,
    avatar: legacyUser.avatar || '',
    defaultOrderNote: legacyUser.defaultOrderNote || '',
    cabbageBalance,
    cabbageHistory: stringifyJson(parseUserCabbageHistory(legacyUser, cabbageBalance), []),
    signState: stringifyJson(signState, {})
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
  const incomingSignState = normalizeSignState(body.signState);
  const currentSignState = current ? ensureMonthlySignState(current) : buildDefaultMonthlySignState();
  const persistedCabbageBalance = current ? formatCabbageNumber(currentCabbageBalance, 2200.00) : incomingCabbageBalance;
  const persistedCabbageHistory = current
    ? (currentCabbageHistory.length > 0 ? currentCabbageHistory : makeDefaultCabbageHistory(persistedCabbageBalance))
    : incomingCabbageHistory;
  const persistedSignState = current ? currentSignState : (Object.keys(incomingSignState.days || {}).length ? incomingSignState : buildDefaultMonthlySignState());

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
    cabbageHistory: stringifyJson(persistedCabbageHistory, []),
    signState: stringifyJson(persistedSignState, {})
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

function getOptionalRequestUserId(req, body = {}) {
  const raw = body.debugUserId
    || body.userId
    || body.clientUserId
    || req.query.userId
    || req.query.clientUserId
    || req.headers['x-debug-user-id'];
  if (raw) return String(raw).trim();
  const wxOpenid = req.headers['x-wx-openid'];
  return wxOpenid ? `wx_${wxOpenid}` : '';
}

async function requireLifeShareUser(req, body = {}) {
  const userId = getOptionalRequestUserId(req, body);
  const user = await findUserByIdOrLoginKey(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 401;
    err.clientMessage = '请先登录后再操作';
    throw err;
  }
  return user;
}

function getClientRegionHeaderText(req) {
  const raw = req.headers['x-wx-client-province']
    || req.headers['x-client-province']
    || req.headers['x-real-province']
    || req.headers['x-region']
    || '';
  const text = String(Array.isArray(raw) ? raw[0] : raw).trim();
  return /^[\u4e00-\u9fa5]{2,8}$/.test(text) ? text.slice(0, 8) : '';
}

function normalizeIpv4Text(value) {
  const match = String(value || '')
    .replace(/^::ffff:/, '')
    .trim()
    .match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return match ? match[0] : '';
}

function normalizeIpv6Text(value) {
  const text = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (!text || text.includes('.')) return '';
  if (!/^[0-9a-fA-F:]+$/.test(text) || !text.includes(':')) return '';
  return text.toLowerCase();
}

function isPublicIpv4(value) {
  const parts = String(value || '').trim().split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function isPublicIpv6(value) {
  const text = normalizeIpv6Text(value);
  if (!text || text === '::1' || text === '::') return false;
  if (text.startsWith('fc') || text.startsWith('fd')) return false;
  if (text.startsWith('fe8') || text.startsWith('fe9') || text.startsWith('fea') || text.startsWith('feb')) return false;
  return true;
}

function getHeaderIpCandidates(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return raw
    .split(',')
    .map(item => normalizeIpv4Text(item) || normalizeIpv6Text(item))
    .filter(Boolean);
}

function getClientIpText(req) {
  const headers = req.headers || {};
  const candidates = [
    ...getHeaderIpCandidates(headers['x-wx-client-ip']),
    ...getHeaderIpCandidates(headers['x-client-ip']),
    ...getHeaderIpCandidates(headers['cf-connecting-ip']),
    ...getHeaderIpCandidates(headers['x-real-ip']),
    ...getHeaderIpCandidates(headers['x-forwarded-for']),
    normalizeIpv4Text(req.ip)
  ].filter(Boolean);

  const publicIp = candidates.find(ip => isPublicIpv4(ip) || isPublicIpv6(ip));
  return (publicIp || candidates[0] || '未知').slice(0, 64);
}

function logLifeShareIpDebug(req, selectedIp, resolvedRegion) {
  const headers = req.headers || {};
  console.log('[life-share-ip]', JSON.stringify({
    selectedIp,
    resolvedRegion,
    xWxClientIp: headers['x-wx-client-ip'] || '',
    xClientIp: headers['x-client-ip'] || '',
    xRealIp: headers['x-real-ip'] || '',
    xForwardedFor: headers['x-forwarded-for'] || '',
    reqIp: req.ip || ''
  }));
}

function normalizeProvinceName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/省$/, '')
    .replace(/市$/, '')
    .replace(/壮族自治区$/, '')
    .replace(/回族自治区$/, '')
    .replace(/维吾尔自治区$/, '')
    .replace(/自治区$/, '')
    .replace(/特别行政区$/, '')
    .slice(0, 8);
}

const GEOIP_CHINA_REGION_MAP = {
  BJ: '北京',
  TJ: '天津',
  HE: '河北',
  SX: '山西',
  NM: '内蒙古',
  LN: '辽宁',
  JL: '吉林',
  HL: '黑龙江',
  SH: '上海',
  JS: '江苏',
  ZJ: '浙江',
  AH: '安徽',
  FJ: '福建',
  JX: '江西',
  SD: '山东',
  HA: '河南',
  HB: '湖北',
  HN: '湖南',
  GD: '广东',
  GX: '广西',
  HI: '海南',
  CQ: '重庆',
  SC: '四川',
  GZ: '贵州',
  YN: '云南',
  XZ: '西藏',
  SN: '陕西',
  GS: '甘肃',
  QH: '青海',
  NX: '宁夏',
  XJ: '新疆',
  TW: '台湾',
  HK: '香港',
  MO: '澳门',
  11: '北京',
  12: '天津',
  13: '河北',
  14: '山西',
  15: '内蒙古',
  21: '辽宁',
  22: '吉林',
  23: '黑龙江',
  31: '上海',
  32: '江苏',
  33: '浙江',
  34: '安徽',
  35: '福建',
  36: '江西',
  37: '山东',
  41: '河南',
  42: '湖北',
  43: '湖南',
  44: '广东',
  45: '广西',
  46: '海南',
  50: '重庆',
  51: '四川',
  52: '贵州',
  53: '云南',
  54: '西藏',
  61: '陕西',
  62: '甘肃',
  63: '青海',
  64: '宁夏',
  65: '新疆',
  71: '台湾',
  81: '香港',
  82: '澳门'
};

const CHINA_REGION_EN_MAP = {
  BEIJING: '北京',
  TIANJIN: '天津',
  HEBEI: '河北',
  SHANXI: '山西',
  INNERMONGOLIA: '内蒙古',
  LIAONING: '辽宁',
  JILIN: '吉林',
  HEILONGJIANG: '黑龙江',
  SHANGHAI: '上海',
  JIANGSU: '江苏',
  ZHEJIANG: '浙江',
  ANHUI: '安徽',
  FUJIAN: '福建',
  JIANGXI: '江西',
  SHANDONG: '山东',
  HENAN: '河南',
  HUBEI: '湖北',
  HUNAN: '湖南',
  GUANGDONG: '广东',
  GUANGXI: '广西',
  HAINAN: '海南',
  CHONGQING: '重庆',
  SICHUAN: '四川',
  GUIZHOU: '贵州',
  YUNNAN: '云南',
  XIZANG: '西藏',
  TIBET: '西藏',
  SHAANXI: '陕西',
  GANSU: '甘肃',
  QINGHAI: '青海',
  NINGXIA: '宁夏',
  XINJIANG: '新疆',
  TAIWAN: '台湾',
  HONGKONG: '香港',
  MACAO: '澳门',
  MACAU: '澳门'
};

const IP2REGION_XDB_HEADER_LENGTH = 256;
const IP2REGION_XDB_VECTOR_INDEX_LENGTH = 256 * 256 * 8;
const IP2REGION_XDB_SEGMENT_INDEX_SIZE = 14;

let offlineIpRanges = null;
let geoipLiteModule;
let ip2RegionXdbBuffer;
const onlineIpRegionCache = new Map();

function getGeoipLiteModule() {
  if (geoipLiteModule !== undefined) return geoipLiteModule;
  try {
    geoipLiteModule = require('geoip-lite');
  } catch (err) {
    geoipLiteModule = null;
  }
  return geoipLiteModule;
}

function normalizeGeoipRegionCode(value) {
  return String(value || '')
    .trim()
    .replace(/^CN[-_]/i, '')
    .toUpperCase();
}

function getGeoipCountryName(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const fallbackNames = {
    CN: '中国',
    HK: '香港',
    MO: '澳门',
    TW: '台湾',
    US: '美国',
    CA: '加拿大',
    GB: '英国',
    JP: '日本',
    KR: '韩国',
    SG: '新加坡',
    TH: '泰国',
    MY: '马来西亚',
    AU: '澳大利亚',
    NZ: '新西兰',
    DE: '德国',
    FR: '法国',
    IT: '意大利',
    ES: '西班牙',
    RU: '俄罗斯',
    IN: '印度',
    BR: '巴西'
  };
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) || fallbackNames[code] || code;
    }
  } catch (err) {
    // Some older Node runtimes do not include Intl.DisplayNames.
  }
  return fallbackNames[code] || code;
}

function normalizeIpRegionPart(value) {
  const text = String(value || '').trim();
  if (!text || text === '0' || text === '未知') return '';
  return text;
}

function parseIp2RegionText(regionText) {
  const parts = String(regionText || '').split('|').map(normalizeIpRegionPart);
  const country = parts[0] || '';
  const province = parts[2] || '';
  if (country === '中国') {
    return normalizeProvinceName(province);
  }
  return country;
}

function normalizeEnglishChinaRegion(value) {
  const key = String(value || '').replace(/[^a-zA-Z]/g, '').toUpperCase();
  return CHINA_REGION_EN_MAP[key] || '';
}

function readJsonFromUrl(url, timeoutMs = 1800, redirectCount = 0) {
  return new Promise(resolve => {
    const client = String(url || '').startsWith('https:') ? https : http;
    const req = client.get(url, {
      timeout: timeoutMs,
      headers: {
        'user-agent': 'Mozilla/5.0 JrshMiniGame/1.0',
        accept: 'application/json,text/plain,*/*'
      }
    }, res => {
      const statusCode = Number(res.statusCode || 0);
      const location = res.headers && res.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location && redirectCount < 2) {
        res.resume();
        resolve(readJsonFromUrl(new URL(location, url).toString(), timeoutMs, redirectCount + 1));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function parseZxincRegionText(value) {
  const parts = String(value || '')
    .split(/[\t\s]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const country = parts[0] || '';
  if (!country || country === '0' || country === '未知') return '';
  if (country !== '中国') return country;
  const province = parts.find(part => /(?:省|市|自治区|特别行政区)$/.test(part) && part !== '中国');
  return normalizeProvinceName(province) || '';
}

function parseZxincRegionResponse(payload) {
  const data = payload && payload.data;
  if (!payload || payload.code !== 0 || !data) return '';
  return parseZxincRegionText(data.country || data.location);
}

function parseIpinfoRegionResponse(payload) {
  if (!payload || !payload.ip) return '';
  const countryCode = String(payload.country || '').trim().toUpperCase();
  const countryName = getGeoipCountryName(countryCode);
  if (!countryName) return '';
  if (countryCode !== 'CN') return countryName;
  return normalizeEnglishChinaRegion(payload.region)
    || normalizeEnglishChinaRegion(payload.org)
    || '';
}

function formatOnlineRegionResult(country, province) {
  const countryText = normalizeIpRegionPart(country);
  const provinceText = normalizeProvinceName(province);
  if (!countryText) return '';
  if (countryText === '中国') return provinceText;
  return countryText;
}

function parseIpApiRegionResponse(payload) {
  if (!payload || payload.status !== 'success') return '';
  return formatOnlineRegionResult(
    payload.country,
    payload.regionName || payload.province || payload.region
  );
}

async function lookupOnlineIpRegion(ip) {
  if (!isPublicIpv4(ip) && !isPublicIpv6(ip)) return '';
  if (onlineIpRegionCache.has(ip)) return onlineIpRegionCache.get(ip);

  const encodedIp = encodeURIComponent(ip);
  const lookups = [
    {
      url: `http://ip.zxinc.org/api.php?type=json&ip=${encodedIp}`,
      timeout: 2500,
      parse: parseZxincRegionResponse
    },
    {
      url: `https://ipinfo.io/${encodedIp}/json`,
      timeout: 2500,
      parse: parseIpinfoRegionResponse
    },
    {
      url: `http://ip-api.com/json/${encodedIp}?lang=zh-CN&fields=status,country,countryCode,regionName,query`,
      timeout: 1800,
      parse: parseIpApiRegionResponse
    }
  ];

  for (const lookup of lookups) {
    const payload = await readJsonFromUrl(lookup.url, lookup.timeout);
    const region = lookup.parse(payload);
    if (region) {
      onlineIpRegionCache.set(ip, region);
      return region;
    }
  }

  onlineIpRegionCache.set(ip, '');
  return '';
}

function loadIp2RegionXdbBuffer() {
  if (ip2RegionXdbBuffer !== undefined) return ip2RegionXdbBuffer;
  const filePath = path.join(__dirname, 'ip2region.xdb');
  try {
    const buffer = fs.readFileSync(filePath);
    ip2RegionXdbBuffer = buffer.length > IP2REGION_XDB_HEADER_LENGTH + IP2REGION_XDB_VECTOR_INDEX_LENGTH
      ? buffer
      : null;
  } catch (err) {
    ip2RegionXdbBuffer = null;
  }
  return ip2RegionXdbBuffer;
}

function lookupIp2RegionXdb(ip) {
  if (!isPublicIpv4(ip)) return '';
  const ipNumber = ipv4ToNumber(ip);
  const buffer = loadIp2RegionXdbBuffer();
  if (ipNumber === null || !buffer) return '';

  const firstByte = (ipNumber >>> 24) & 0xff;
  const secondByte = (ipNumber >>> 16) & 0xff;
  const vectorOffset = IP2REGION_XDB_HEADER_LENGTH + ((firstByte * 256 + secondByte) * 8);
  if (vectorOffset + 8 > buffer.length) return '';

  const startPtr = buffer.readUInt32LE(vectorOffset);
  const endPtr = buffer.readUInt32LE(vectorOffset + 4);
  if (startPtr <= 0 || endPtr <= 0 || startPtr > endPtr || endPtr + IP2REGION_XDB_SEGMENT_INDEX_SIZE > buffer.length) return '';

  let left = 0;
  let right = Math.floor((endPtr - startPtr) / IP2REGION_XDB_SEGMENT_INDEX_SIZE);
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const segmentOffset = startPtr + mid * IP2REGION_XDB_SEGMENT_INDEX_SIZE;
    const startIp = buffer.readUInt32LE(segmentOffset);
    const endIp = buffer.readUInt32LE(segmentOffset + 4);
    if (ipNumber < startIp) {
      right = mid - 1;
    } else if (ipNumber > endIp) {
      left = mid + 1;
    } else {
      const dataLength = buffer.readUInt16LE(segmentOffset + 8);
      const dataPtr = buffer.readUInt32LE(segmentOffset + 10);
      if (dataLength <= 0 || dataPtr <= 0 || dataPtr + dataLength > buffer.length) return '';
      return parseIp2RegionText(buffer.toString('utf8', dataPtr, dataPtr + dataLength));
    }
  }
  return '';
}

function lookupGeoipLiteRegion(ip) {
  if (!isPublicIpv4(ip)) return '';
  const geoip = getGeoipLiteModule();
  if (!geoip || typeof geoip.lookup !== 'function') return '';
  const result = geoip.lookup(ip);
  if (!result || !result.country) return '';
  if (result.country !== 'CN') return getGeoipCountryName(result.country);
  const region = GEOIP_CHINA_REGION_MAP[normalizeGeoipRegionCode(result.region)];
  if (region) return region;
  if (/^[\u4e00-\u9fa5]{2,8}$/.test(String(result.city || '').trim())) {
    return normalizeProvinceName(result.city) || '';
  }
  return '';
}

function ipv4ToNumber(ip) {
  const parts = String(ip || '').trim().split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function loadOfflineIpRanges() {
  if (offlineIpRanges !== null) return offlineIpRanges;
  const filePath = path.join(__dirname, 'ip-region-ranges.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    offlineIpRanges = Array.isArray(parsed)
      ? parsed.map(item => ({
          start: Number(item.start),
          end: Number(item.end),
          region: normalizeProvinceName(item.region)
        })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.region)
      : [];
  } catch (err) {
    offlineIpRanges = [];
  }
  return offlineIpRanges;
}

function lookupOfflineIpRegion(ip) {
  if (!isPublicIpv4(ip)) return '';
  const ip2Region = lookupIp2RegionXdb(ip);
  if (ip2Region) return ip2Region;
  const ipNumber = ipv4ToNumber(ip);
  if (ipNumber === null) return '';
  const ranges = loadOfflineIpRanges();
  let left = 0;
  let right = ranges.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const item = ranges[mid];
    if (ipNumber < item.start) {
      right = mid - 1;
    } else if (ipNumber > item.end) {
      left = mid + 1;
    } else {
      return item.region;
    }
  }
  return lookupGeoipLiteRegion(ip);
}

async function resolveIpRegionText(value) {
  const text = String(value || '').trim();
  if (!text || text === '未知') return '未知';
  if (/^[\u4e00-\u9fa5]{2,8}$/.test(text)) return normalizeProvinceName(text) || '未知';
  const onlineRegion = await lookupOnlineIpRegion(text);
  if (onlineRegion) return onlineRegion;
  return lookupOfflineIpRegion(text) || '未知';
}

async function getClientRegionText(req, ipAddress = '') {
  const regionFromIp = await resolveIpRegionText(ipAddress || getClientIpText(req));
  if (regionFromIp && regionFromIp !== '未知') return regionFromIp;
  const headerRegion = getClientRegionHeaderText(req);
  return headerRegion ? (normalizeProvinceName(headerRegion) || headerRegion) : '未知';
}

function normalizeLifeShareImages(images) {
  return (Array.isArray(images) ? images : [])
    .map(image => String(image || '').trim())
    .filter(Boolean)
    .slice(0, 9);
}

async function toClientLifeShareComment(comment, userMap = {}, parentCommentMap = {}) {
  const row = comment && comment.toJSON ? comment.toJSON() : (comment || {});
  const user = userMap[String(row.userId || '')] || {};
  const parentComment = parentCommentMap[String(row.parentCommentId || '')] || {};
  const parentUser = userMap[String(parentComment.userId || '')] || {};
  const createdAt = row.createdAt || new Date();
  return {
    id: row.id,
    postId: row.postId,
    userId: row.userId,
    parentCommentId: row.parentCommentId || '',
    parentUserName: parentUser.nickname || '',
    userName: user.nickname || '用户',
    userAvatar: user.avatar || '',
    content: row.content || '',
    createdAt: new Date(createdAt).getTime(),
    createdAtText: formatDateTime(createdAt)
  };
}

async function buildLifeShareUserMap(userIds = []) {
  const ids = Array.from(new Set(userIds.map(id => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return {};
  const users = await User.findAll({
    where: { id: { [Op.in]: ids } }
  });
  return users.reduce((map, user) => {
    const row = user.toJSON ? user.toJSON() : user;
    map[String(row.id)] = row;
    return map;
  }, {});
}

async function buildLifeShareLikeCountMap(postIds = []) {
  const ids = Array.from(new Set(postIds.map(id => String(id || '').trim()).filter(Boolean)));
  const result = {};
  await Promise.all(ids.map(async id => {
    result[id] = await LifeShareLike.count({ where: { postId: id } });
  }));
  return result;
}

async function buildLifeShareCommentCountMap(postIds = []) {
  const ids = Array.from(new Set(postIds.map(id => String(id || '').trim()).filter(Boolean)));
  const result = {};
  await Promise.all(ids.map(async id => {
    result[id] = await LifeShareComment.count({ where: { postId: id, status: 'visible' } });
  }));
  return result;
}

async function buildCurrentUserLikedSet(postIds = [], currentUserId = '') {
  const ids = Array.from(new Set(postIds.map(id => String(id || '').trim()).filter(Boolean)));
  const userId = String(currentUserId || '').trim();
  if (!ids.length || !userId) return new Set();
  const likes = await LifeShareLike.findAll({
    where: {
      userId,
      postId: { [Op.in]: ids }
    }
  });
  return new Set(likes.map(like => String((like.toJSON ? like.toJSON() : like).postId || '')));
}

async function toClientLifeSharePost(post, options = {}) {
  const row = post && post.toJSON ? post.toJSON() : (post || {});
  const userMap = options.userMap || await buildLifeShareUserMap([row.authorUserId]);
  const author = userMap[String(row.authorUserId || '')] || {};
  const postId = String(row.id || '');
  const likeCount = options.likeCountMap && options.likeCountMap[postId] !== undefined
    ? options.likeCountMap[postId]
    : await LifeShareLike.count({ where: { postId } });
  const commentCount = options.commentCountMap && options.commentCountMap[postId] !== undefined
    ? options.commentCountMap[postId]
    : await LifeShareComment.count({ where: { postId, status: 'visible' } });
  const likedSet = options.likedSet || new Set();
  const viewCount = Number(row.viewCount || 0);
  const createdAt = row.createdAt || new Date();
  const comments = Array.isArray(options.comments) ? options.comments : undefined;
  const storedIpText = String(row.ipText || '').trim();
  const storedIpAddress = String(row.ipAddress || '').trim();
  const ipRegionSource = storedIpAddress || storedIpText || '未知';

  return {
    id: postId,
    authorUserId: row.authorUserId || '',
    authorName: author.nickname || '用户',
    authorAvatar: author.avatar || '',
    content: row.content || '',
    images: normalizeLifeShareImages(parseJson(row.images, [])),
    createdAt: new Date(createdAt).getTime(),
    createdAtText: formatDateTime(createdAt),
    ipText: await resolveIpRegionText(ipRegionSource),
    viewCount: Number.isNaN(viewCount) ? 0 : viewCount,
    likeCount,
    commentCount,
    heatCount: (Number.isNaN(viewCount) ? 0 : viewCount) + likeCount + commentCount,
    liked: likedSet.has(postId),
    ...(comments ? { comments } : {})
  };
}

function getLifeShareNotificationTypeText(type) {
  const map = {
    like: '点赞',
    comment: '评论',
    reply: '回复'
  };
  return map[String(type || '').trim()] || '互动';
}

async function buildLifeSharePostMap(postIds = []) {
  const ids = Array.from(new Set(postIds.map(id => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return {};
  const posts = await LifeSharePost.findAll({ where: { id: { [Op.in]: ids } } });
  return posts.reduce((result, post) => {
    const row = post.toJSON ? post.toJSON() : post;
    result[String(row.id || '')] = row;
    return result;
  }, {});
}

async function createLifeShareNotification(payload = {}) {
  const recipientUserId = String(payload.recipientUserId || '').trim();
  const actorUserId = String(payload.actorUserId || '').trim();
  const postId = String(payload.postId || '').trim();
  const type = String(payload.type || '').trim();
  if (!recipientUserId || !actorUserId || !postId || !type || recipientUserId === actorUserId) return null;
  return LifeShareNotification.create({
    id: makeId('life_notice'),
    recipientUserId,
    actorUserId,
    postId,
    commentId: String(payload.commentId || '').trim() || null,
    parentCommentId: String(payload.parentCommentId || '').trim() || null,
    type,
    content: String(payload.content || '').trim().slice(0, 300),
    readStatus: 'unread',
    status: 'visible'
  });
}

async function toClientLifeShareNotification(notification, options = {}) {
  const row = notification && notification.toJSON ? notification.toJSON() : (notification || {});
  const userMap = options.userMap || {};
  const postMap = options.postMap || {};
  const actor = userMap[String(row.actorUserId || '')] || {};
  const post = postMap[String(row.postId || '')] || {};
  const createdAt = row.createdAt || new Date();
  return {
    id: row.id,
    type: row.type || '',
    typeText: getLifeShareNotificationTypeText(row.type),
    actorUserId: row.actorUserId || '',
    actorName: actor.nickname || '用户',
    actorAvatar: actor.avatar || '',
    postId: row.postId || '',
    commentId: row.commentId || '',
    parentCommentId: row.parentCommentId || '',
    content: row.content || '',
    postContent: String(post.content || '').slice(0, 80),
    createdAt: new Date(createdAt).getTime(),
    createdAtText: formatDateTime(createdAt)
  };
}

function normalizeKitchenState(kitchenId, ownerUserId, state = {}, options = {}) {
  const normalizedOrders = normalizeOrderList(state.orders);
  const normalizedDishes = normalizeDishList(state.dishes);
  const kitchenInfo = normalizeKitchenInfo(kitchenId, state.kitchenInfo || {});

  if (isLegacyDefaultKitchenName(kitchenInfo.name)) {
    kitchenInfo.name = options.defaultKitchenName || makeDefaultKitchenName();
  }

  const kitchenCode = isKitchenCode(options.kitchenCode)
    ? options.kitchenCode
    : (isKitchenCode(state.kitchenCode)
        ? state.kitchenCode
        : (isKitchenCode(kitchenInfo.kitchenCode) ? kitchenInfo.kitchenCode : ''));
  if (kitchenCode) {
    kitchenInfo.kitchenCode = kitchenCode;
  }

  const payload = {
    id: kitchenId,
    ownerUserId,
    kitchenCode: kitchenCode || null,
    kitchenInfo: stringifyJson(kitchenInfo, {}),
    categories: stringifyJson(Array.isArray(state.categories) ? state.categories : ['未分类'], []),
    dishes: stringifyJson(normalizedDishes, []),
    orders: stringifyJson(normalizedOrders, []),
    lastQueueCode: state.lastQueueCode || null,
    isPublic: !!kitchenInfo.isPublic,
    businessOpen: !!kitchenInfo.businessOpen,
    businessStart: kitchenInfo.businessStart,
    businessEnd: kitchenInfo.businessEnd,
    displaySettings: stringifyJson(kitchenInfo.displaySettings, {})
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
    where: { ownerUserId: userId, dissolvedAt: null },
    order: [['updatedAt', 'DESC']]
  });
  kitchen = await migrateLegacyKitchen(kitchen);
  if (kitchen) {
    const kitchenCode = await ensureKitchenCode(kitchen);
    const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
    const kitchenInfo = getKitchenInfoWithId(row.kitchenInfo, row.id);
    kitchenInfo.legacyId = row.legacyId || '';
    kitchenInfo.kitchenCode = kitchenCode;
    if (isLegacyDefaultKitchenName(kitchenInfo.name)) {
      kitchenInfo.name = defaultKitchenName;
      await kitchen.update({ kitchenInfo: stringifyJson(kitchenInfo, {}) });
    }
    return kitchen;
  }

  const localKitchenId = state.kitchenInfo && state.kitchenInfo.id;
  const kitchenId = isNumericKitchenId(localKitchenId) ? localKitchenId : await makeNumericKitchenId();
  const kitchenCode = await makeKitchenCode(
    isKitchenCode(localKitchenId)
      ? localKitchenId
      : ((state.kitchenInfo && state.kitchenInfo.kitchenCode) || state.kitchenCode || ''),
    kitchenId
  );
  const options = {
    ...(localKitchenId && localKitchenId !== kitchenId ? { legacyId: localKitchenId } : {}),
    kitchenCode,
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
  const kitchenCode = await ensureKitchenCode(kitchen);
  const kitchenInfo = normalizeKitchenInfo(
    row.id,
    parseJson(row.kitchenInfo, { id: row.id, name: makeDefaultKitchenName() }),
    row
  );
  const orders = await loadKitchenOrders(row);
  const dishes = await loadKitchenDishes(row);
  const legacyId = row.legacyId || '';
  return {
    kitchenId: row.id,
    ownerUserId: row.ownerUserId,
    legacyId,
    kitchenCode,
    kitchenInfo: {
      ...kitchenInfo,
      legacyId,
      kitchenCode
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
    where: { ownerUserId: user.id, dissolvedAt: null },
    order: [['updatedAt', 'DESC'], ['id', 'DESC']]
  });
  const effectiveOwnedKitchens = ownedKitchens.length ? ownedKitchens : [ownerKitchen];
  const ownKitchenOrders = await loadOwnedKitchenOrders(effectiveOwnedKitchens);
  const ownedKitchenSummaries = await Promise.all(effectiveOwnedKitchens.map(toClientKitchenSummary));

  res.send({
    user: toClientUser(user),
    ownerKitchenId: ownerKitchen.id,
    isVisitingKitchen: kitchen.id !== ownerKitchen.id,
    userOrders: userOrders.map(toClientOrder),
    ownKitchenOrders,
    ownedKitchens: ownedKitchenSummaries,
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

app.delete('/api/orders/:id', asyncHandler(async (req, res) => {
  const orderId = String(req.params.id || '').trim();
  const body = req.body || {};
  const operatorUserId = String(body.userId || body.clientUserId || getRequestUserId(req, body) || '').trim();
  if (!orderId || !operatorUserId) {
    res.status(400).send({ ok: false, error: 'Invalid request', message: '订单参数缺失' });
    return;
  }

  const operator = await findUserByIdOrLoginKey(operatorUserId);
  if (!operator) {
    res.status(404).send({ ok: false, error: 'User not found', message: '用户不存在' });
    return;
  }

  const current = await Order.findOne({ where: { id: orderId } });
  if (!current) {
    res.status(404).send({ ok: false, error: 'Order not found', message: '订单不存在' });
    return;
  }

  const row = current.toJSON ? current.toJSON() : current;
  const payload = parseJson(row.payload, {});
  const buyerUserId = String(payload.userId || row.ownerUserId || '').trim();
  const merchantUserId = String(payload.merchantUserId || payload.kitchenOwnerUserId || '').trim();
  const isBuyer = buyerUserId && buyerUserId === String(operator.id);
  const isMerchant = merchantUserId && merchantUserId === String(operator.id);

  if (!isBuyer && !isMerchant) {
    res.status(403).send({ ok: false, error: 'Forbidden', message: '只能删除自己的订单记录' });
    return;
  }

  const status = String(payload.status || row.status || '').trim();
  if (status !== 'completed' && status !== 'cancelled') {
    res.status(409).send({ ok: false, error: 'Order active', message: '请先完成或取消订单' });
    return;
  }

  const kitchen = await findKitchenByIdOrLegacy(row.kitchenId);
  if (kitchen) {
    const kitchenRow = kitchen.toJSON ? kitchen.toJSON() : kitchen;
    const legacyOrders = normalizeOrderList(kitchenRow.orders).filter(item => String(item.id || '') !== orderId);
    await kitchen.update({
      orders: stringifyJson(legacyOrders, [])
    });
  }

  await current.destroy();
  res.send({
    ok: true,
    deletedOrderId: orderId
  });
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

app.get('/api/users/:id/sign-state', asyncHandler(async (req, res) => {
  const user = await findUserByIdOrLoginKey(req.params.id);
  if (!user) {
    res.status(404).send({ error: 'User not found' });
    return;
  }

  const current = await toClientUserWithDecoratedHistory(user);
  const signState = ensureMonthlySignState(current);
  res.send({
    userId: current.id,
    signState
  });
}));

app.post('/api/users/:id/sign-in', asyncHandler(async (req, res) => {
  const user = await findUserByIdOrLoginKey(req.params.id);
  if (!user) {
    res.status(404).send({ ok: false, error: 'User not found', message: '用户不存在' });
    return;
  }

  const result = await sequelize.transaction(async transaction => {
    const lockedUser = await User.findByPk((user.toJSON ? user.toJSON() : user).id, { transaction, lock: true });
    if (!lockedUser) {
      return { status: 404, payload: { ok: false, error: 'User not found', message: '用户不存在' } };
    }

    const row = lockedUser.toJSON ? lockedUser.toJSON() : lockedUser;
    const signState = ensureMonthlySignState(row);
    const currentMonthKey = makeMonthlySignKey();
    if (signState.monthKey !== currentMonthKey) {
      return { status: 409, payload: { ok: false, error: 'Sign state expired', message: '签到状态已过期，请重试' } };
    }

    const body = req.body || {};
    const requestedDay = Object.prototype.hasOwnProperty.call(body, 'day')
      ? parseInt(body.day, 10)
      : parseInt(new Date().getDate(), 10);
    if (!Number.isFinite(requestedDay) || requestedDay < 1 || requestedDay > 30) {
      return { status: 409, payload: { ok: false, error: 'Sign day invalid', message: '签到日期无效' } };
    }

    const targetEntry = signState.days[String(requestedDay)];
    if (!targetEntry) {
      return { status: 409, payload: { ok: false, error: 'Sign day invalid', message: '该签到日期不可用' } };
    }
    if (targetEntry.signed) {
      return { status: 409, payload: { ok: false, error: 'Already signed', message: '这一天已经签到过了' } };
    }

    const action = getMonthlySignAction(requestedDay, false);
    if (!action.canSign && !action.canMakeUp) {
      return { status: 409, payload: { ok: false, error: 'Cannot sign day', message: '还未到该签到日期' } };
    }

    const makeUpCost = action.canMakeUp ? 500 : 0;
    const reward = Number(targetEntry.reward) || getMonthlySignReward(currentMonthKey, requestedDay);
    const currentBalance = formatCabbageNumber(row.cabbageBalance, 2200.00);
    if (makeUpCost > 0 && currentBalance < makeUpCost) {
      return { status: 409, payload: { ok: false, error: 'Insufficient balance', message: '大白菜不足，补签需要 500 大白菜' } };
    }
    const balanceAfterCost = formatCabbageNumber(currentBalance - makeUpCost, 0);
    const nextBalance = formatCabbageNumber(balanceAfterCost + reward, 0);
    const currentHistory = parseUserCabbageHistory(row, currentBalance);
    const nextHistory = makeUpCost > 0
      ? [
          makeCabbageHistoryEntry('add', reward, `补签奖励(${currentMonthKey}-第${requestedDay}天)`, nextBalance),
          makeCabbageHistoryEntry('sub', makeUpCost, `补签消耗(${currentMonthKey}-第${requestedDay}天)`, balanceAfterCost),
          ...currentHistory
        ]
      : [
          makeCabbageHistoryEntry('add', reward, `每日签到(${currentMonthKey}-第${requestedDay}天)`, nextBalance),
          ...currentHistory
        ];

    const signedAt = new Date().toISOString();
    const makeUpLogs = Array.isArray(signState.makeUpLogs) ? signState.makeUpLogs : [];
    if (makeUpCost > 0) {
      makeUpLogs.unshift({
        day: requestedDay,
        signedAt,
        cost: formatCabbageNumberText(makeUpCost, 0),
        reward: formatCabbageNumberText(reward, 0)
      });
    }

    signState.days[String(requestedDay)] = {
      ...targetEntry,
      signed: true,
      canSign: false,
      canMakeUp: false,
      signedAt
    };
    signState.makeUpLogs = makeUpLogs;

    await lockedUser.update({
      cabbageBalance: nextBalance,
      cabbageHistory: stringifyJson(nextHistory, []),
      signState: stringifyJson(signState, {})
    }, { transaction });

    return {
      status: 200,
      mode: makeUpCost > 0 ? 'makeup' : 'sign',
      day: requestedDay,
      cost: makeUpCost,
      reward,
      userId: row.id
    };
  });

  if (!result || result.status !== 200) {
    const failure = result || { status: 500, payload: { ok: false, error: 'Sign in failed', message: '签到失败' } };
    res.status(failure.status).send(failure.payload);
    return;
  }

  const refreshedUser = await User.findByPk(result.userId);
  res.send({
    ok: true,
    mode: result.mode,
    day: result.day,
    cost: formatCabbageNumberText(result.cost, 0),
    reward: formatCabbageNumberText(result.reward, 0),
    user: await toClientUserWithDecoratedHistory(refreshedUser)
  });
}));

app.post('/api/users/:id/sign-task-reward', asyncHandler(async (req, res) => {
  const user = await findUserByIdOrLoginKey(req.params.id);
  if (!user) {
    res.status(404).send({ ok: false, error: 'User not found', message: '用户不存在' });
    return;
  }

  const result = await sequelize.transaction(async transaction => {
    const lockedUser = await User.findByPk((user.toJSON ? user.toJSON() : user).id, { transaction, lock: true });
    if (!lockedUser) {
      return { status: 404, payload: { ok: false, error: 'User not found', message: '用户不存在' } };
    }

    const body = req.body || {};
    const milestone = parseInt(body.milestone, 10);
    const rewardAmount = MONTHLY_SIGN_TASK_REWARDS[milestone];
    if (!rewardAmount) {
      return { status: 409, payload: { ok: false, error: 'Invalid milestone', message: '签到任务无效' } };
    }

    const row = lockedUser.toJSON ? lockedUser.toJSON() : lockedUser;
    const signState = ensureMonthlySignState(row);
    const signedDays = countSignedDays(signState);
    if (signedDays < milestone) {
      return { status: 409, payload: { ok: false, error: 'Requirement not met', message: '累计签到天数不足，暂时不能领取' } };
    }

    const rewardState = signState.claimedRewards && signState.claimedRewards[String(milestone)]
      ? signState.claimedRewards[String(milestone)]
      : null;
    if (rewardState && rewardState.claimed) {
      return { status: 409, payload: { ok: false, error: 'Already claimed', message: '该签到奖励已经领取过了' } };
    }

    const currentBalance = formatCabbageNumber(row.cabbageBalance, 2200.00);
    const nextBalance = formatCabbageNumber(currentBalance + rewardAmount, 0);
    const currentHistory = parseUserCabbageHistory(row, currentBalance);
    const nextHistory = [
      makeCabbageHistoryEntry('add', rewardAmount, `累签${milestone}天奖励(${signState.monthKey})`, nextBalance),
      ...currentHistory
    ];

    signState.claimedRewards[String(milestone)] = {
      milestone,
      claimed: true,
      claimedAt: new Date().toISOString(),
      reward: formatCabbageNumberText(rewardAmount, 0)
    };

    await lockedUser.update({
      cabbageBalance: nextBalance,
      cabbageHistory: stringifyJson(nextHistory, []),
      signState: stringifyJson(signState, {})
    }, { transaction });

    return {
      status: 200,
      milestone,
      reward: rewardAmount,
      userId: row.id
    };
  });

  if (!result || result.status !== 200) {
    const failure = result || { status: 500, payload: { ok: false, error: 'Claim sign reward failed', message: '领取签到奖励失败' } };
    res.status(failure.status).send(failure.payload);
    return;
  }

  const refreshedUser = await User.findByPk(result.userId);
  res.send({
    ok: true,
    milestone: result.milestone,
    reward: formatCabbageNumberText(result.reward, 0),
    user: await toClientUserWithDecoratedHistory(refreshedUser)
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
    ? normalizeCabbageHistory(body.history, nextBalance, { keepEmpty: true })
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

app.get('/api/kitchens/public-search', asyncHandler(async (req, res) => {
  const keyword = String((req.query && req.query.keyword) || '').trim().slice(0, 32);
  const where = keyword
    ? {
        dissolvedAt: null,
        [Op.or]: [
          { id: keyword },
          { legacyId: keyword },
          { kitchenCode: keyword }
        ]
      }
    : { dissolvedAt: null };

  const queryOptions = {
    attributes: ['id', 'ownerUserId', 'legacyId', 'kitchenCode', 'kitchenInfo', 'dishes', 'isPublic', 'businessOpen', 'businessStart', 'businessEnd', 'displaySettings', 'createdAt', 'updatedAt', 'dissolvedAt'],
    where,
    order: [['updatedAt', 'DESC']]
  };
  if (keyword) queryOptions.limit = 20;

  const kitchens = await Kitchen.findAll(queryOptions);

  const summaries = (await Promise.all(kitchens.map(toClientKitchenSummary)))
    .filter(kitchen => kitchen.isPublic)
    .sort(compareKitchenRecommendation);
  const ownerIds = Array.from(new Set(summaries.map(kitchen => kitchen.ownerUserId).filter(Boolean)));
  const users = ownerIds.length
    ? await User.findAll({
        attributes: ['id', 'nickname'],
        where: { id: { [Op.in]: ownerIds } }
      })
    : [];
  const nicknameById = users.reduce((map, user) => {
    const row = user.toJSON ? user.toJSON() : user;
    map[row.id] = row.nickname || '';
    return map;
  }, {});

  res.send({
    kitchens: summaries.map(kitchen => ({
      ...kitchen,
      ownerNickname: nicknameById[kitchen.ownerUserId] || '',
      cloneCost: Number(kitchen.dishCount || 0) * 200
    }))
  });
}));

app.get('/api/dishes/public-feed', asyncHandler(async (req, res) => {
  const keyword = String((req.query && req.query.keyword) || '').trim().slice(0, 32).toLowerCase();
  const kitchens = await Kitchen.findAll({
    attributes: ['id', 'ownerUserId', 'legacyId', 'kitchenCode', 'kitchenInfo', 'dishes', 'isPublic', 'displaySettings', 'createdAt', 'updatedAt', 'dissolvedAt'],
    where: {
      dissolvedAt: null
    },
    order: [['updatedAt', 'DESC']]
  });

  const publicKitchens = await Promise.all(kitchens.map(async kitchen => {
    const summary = await toClientKitchenSummary(kitchen);
    const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
    const info = normalizeKitchenInfo(row.id, parseJson(row.kitchenInfo, {}), row);
    return {
      ...summary,
      kitchenInfo: info,
      rawRow: row
    };
  }));

  const ownerIds = Array.from(new Set(publicKitchens.map(kitchen => kitchen.ownerUserId).filter(Boolean)));
  const users = ownerIds.length
    ? await User.findAll({
        attributes: ['id', 'nickname', 'avatar'],
        where: { id: { [Op.in]: ownerIds } }
      })
    : [];
  const userMap = users.reduce((map, user) => {
    const row = user.toJSON ? user.toJSON() : user;
    map[String(row.id)] = row;
    return map;
  }, {});

  const feed = [];
  const stolenDishCountMap = buildStolenDishCountMap(publicKitchens.map(kitchen => kitchen.rawRow || kitchen));

  publicKitchens
    .filter(kitchen => kitchen.isPublic)
    .sort(compareKitchenRecommendation)
    .forEach(kitchen => {
      const sourceRow = kitchen.rawRow || {};
      const kitchenInfo = kitchen.kitchenInfo || {};
      const dishes = normalizeDishList(sourceRow.dishes)
        .filter(dish => dish && dish.isPublic)
        .filter(dish => {
          if (!keyword) return true;
          const name = String(dish.name || '').toLowerCase();
          return name.includes(keyword);
        });

      const displaySettings = kitchen.displaySettings || kitchenInfo.displaySettings || {};
      const owner = userMap[String(kitchen.ownerUserId)] || {};

      dishes.forEach(dish => {
        const stealCount = stolenDishCountMap[makeStolenDishKey(kitchen.id, dish.id)] || 0;
        feed.push({
          id: `${kitchen.id}::${String(dish.id || '')}`,
          kitchenId: kitchen.id,
          kitchenCode: kitchen.kitchenCode || '',
          kitchenName: kitchen.name || '未命名厨房',
          ownerUserId: kitchen.ownerUserId || '',
          ownerNickname: owner.nickname || '',
          ownerAvatar: owner.avatar || '',
          kitchenLogo: kitchen.logo || '',
          dishId: String(dish.id || ''),
          name: dish.name || '未命名菜谱',
          image: dish.image || '',
          desc: String(dish.desc || '').trim(),
          price: dish.price !== undefined && dish.price !== null ? dish.price : '0.00',
          stars: Number(dish.stars || 5),
          sales: Number(dish.sales || 0),
          category: String(dish.category || '').trim() || '未分类',
          tags: Array.isArray(dish.tags) ? dish.tags : [],
          isPublic: true,
          kitchenIsPublic: true,
          stealCount: Number(stealCount || 0),
          displaySettings,
          updatedAt: dish.updatedAt || kitchen.updatedAt || null,
          createdAt: dish.createdAt || kitchen.createdAt || null
        });
      });
    });

  feed.sort((left, right) => {
    const stealDiff = Number(right.stealCount || 0) - Number(left.stealCount || 0);
    if (stealDiff !== 0) return stealDiff;
    const starDiff = Number(right.stars || 0) - Number(left.stars || 0);
    if (starDiff !== 0) return starDiff;
    const salesDiff = Number(right.sales || 0) - Number(left.sales || 0);
    if (salesDiff !== 0) return salesDiff;
    const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
    const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  res.send({
    dishes: feed.slice(0, keyword ? 100 : 200)
  });
}));

app.get('/api/dishes/public-detail', asyncHandler(async (req, res) => {
  const kitchenId = String((req.query && req.query.kitchenId) || '').trim();
  const dishId = String((req.query && req.query.dishId) || '').trim();

  if (!kitchenId || !dishId) {
    res.status(400).send({ ok: false, error: 'Invalid query', message: '菜谱参数缺失' });
    return;
  }

  const kitchen = await findKitchenByIdOrLegacy(kitchenId);
  if (!kitchen) {
    res.status(404).send({ ok: false, error: 'Kitchen not found', message: '厨房不存在' });
    return;
  }

  const summary = await toClientKitchenSummary(kitchen);
  if (!summary.isPublic) {
    res.status(403).send({ ok: false, error: 'Kitchen private', message: '该厨房未公开' });
    return;
  }

  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  const kitchenInfo = normalizeKitchenInfo(row.id, parseJson(row.kitchenInfo, {}), row);
  const displaySettings = summary.displaySettings || kitchenInfo.displaySettings || {};
  const dish = normalizeDishList(row.dishes).find(item => (
    item && item.isPublic && String(item.id || '') === dishId
  ));
  const stolenDishCountMap = buildStolenDishCountMap(await Kitchen.findAll({
    attributes: ['id', 'kitchenInfo'],
    where: {
      dissolvedAt: null
    }
  }));

  if (!dish) {
    res.status(404).send({ ok: false, error: 'Dish not found', message: '公开菜谱不存在' });
    return;
  }

  const owner = row.ownerUserId
    ? await User.findByPk(row.ownerUserId, { attributes: ['id', 'nickname', 'avatar'] })
    : null;
  const ownerRow = owner && owner.toJSON ? owner.toJSON() : (owner || {});

  res.send({
    dish: {
      id: `${row.id}::${String(dish.id || '')}`,
      dishId: String(dish.id || ''),
      kitchenId: row.id,
      kitchenCode: summary.kitchenCode || '',
      kitchenName: summary.name || '未命名厨房',
      kitchenLogo: summary.logo || '',
      ownerUserId: row.ownerUserId || '',
      ownerNickname: ownerRow.nickname || '',
      ownerAvatar: ownerRow.avatar || '',
      name: dish.name || '未命名菜谱',
      category: String(dish.category || '').trim() || '未分类',
      desc: String(dish.desc || '').trim(),
      image: dish.image || '',
      subImages: Array.isArray(dish.subImages) ? dish.subImages : [],
      price: dish.price !== undefined && dish.price !== null ? dish.price : '0.00',
      stars: Number(dish.stars || 5),
      sales: Number(dish.sales || 0),
      stealCount: Number(stolenDishCountMap[makeStolenDishKey(row.id, dishId)] || 0),
      stock: dish.stock !== undefined && dish.stock !== null ? dish.stock : 999,
      isRequired: !!dish.isRequired,
      ingredients: Array.isArray(dish.ingredients) ? dish.ingredients : [],
      steps: Array.isArray(dish.steps) ? dish.steps : [],
      duration: String(dish.duration || '').trim(),
      difficulty: String(dish.difficulty || '').trim(),
      cookware: String(dish.cookware || '').trim(),
      portion: String(dish.portion || '').trim(),
      unit: String(dish.unit || '').trim(),
      calories: dish.calories !== undefined && dish.calories !== null ? String(dish.calories).trim() : '',
      protein: dish.protein !== undefined && dish.protein !== null ? String(dish.protein).trim() : '',
      carbs: dish.carbs !== undefined && dish.carbs !== null ? String(dish.carbs).trim() : '',
      fat: dish.fat !== undefined && dish.fat !== null ? String(dish.fat).trim() : '',
      tags: Array.isArray(dish.tags) ? dish.tags : [],
      specs: Array.isArray(dish.specs) ? dish.specs : [],
      displaySettings,
      updatedAt: dish.updatedAt || row.updatedAt || null,
      createdAt: dish.createdAt || row.createdAt || null
    }
  });
}));

app.post('/api/kitchens/:id/steal-dish', asyncHandler(async (req, res) => {
  const sourceKitchenId = String(req.params.id || '').trim();
  const body = req.body || {};
  const operatorUserId = String(body.userId || body.clientUserId || getRequestUserId(req, body) || '').trim();
  const targetKitchenId = String(body.targetKitchenId || '').trim();
  const sourceDishId = String(body.sourceDishId || body.dishId || '').trim();
  const targetCategory = (String(body.targetCategory || '未分类').trim() || '未分类').slice(0, 128);

  if (!sourceKitchenId || !targetKitchenId || !sourceDishId || !operatorUserId) {
    res.status(400).send({ ok: false, error: 'Steal dish required', message: '偷菜参数缺失' });
    return;
  }

  const resolvedOperator = await findUserByIdOrLoginKey(operatorUserId);
  if (!resolvedOperator) {
    res.status(404).send({ ok: false, error: 'User not found', message: '用户不存在' });
    return;
  }

  const resolvedSourceKitchen = await findKitchenByIdOrLegacy(sourceKitchenId);
  if (!resolvedSourceKitchen) {
    res.status(404).send({ ok: false, error: 'Source kitchen not found', message: '厨房不存在' });
    return;
  }

  const resolvedTargetKitchen = await findKitchenByIdOrLegacy(targetKitchenId);
  if (!resolvedTargetKitchen) {
    res.status(404).send({ ok: false, error: 'Target kitchen not found', message: '当前厨房不存在' });
    return;
  }

  const resolvedOperatorRow = resolvedOperator.toJSON ? resolvedOperator.toJSON() : resolvedOperator;
  const resolvedSourceRow = resolvedSourceKitchen.toJSON ? resolvedSourceKitchen.toJSON() : resolvedSourceKitchen;
  const resolvedTargetRow = resolvedTargetKitchen.toJSON ? resolvedTargetKitchen.toJSON() : resolvedTargetKitchen;
  if (String(resolvedSourceRow.id) === String(resolvedTargetRow.id)) {
    res.status(409).send({ ok: false, error: 'Cannot steal current kitchen', message: '不能偷当前厨房的菜' });
    return;
  }

  const stealResult = await sequelize.transaction(async transaction => {
    const loadLockedKitchen = async id => Kitchen.findOne({
      where: { id, dissolvedAt: null },
      transaction,
      lock: true
    });
    const loadLockedKitchenDishes = async row => {
      const legacyDishes = normalizeDishList(row.dishes);
      const rows = await Dish.findAll({
        where: { kitchenId: row.id },
        order: [['sortIndex', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']],
        transaction,
        lock: true
      });
      return rows.length > 0 ? rows.map(toClientDish) : legacyDishes;
    };

    const kitchenIds = Array.from(new Set([resolvedSourceRow.id, resolvedTargetRow.id].map(id => String(id)))).sort();
    const kitchenById = {};
    for (const id of kitchenIds) {
      const kitchen = await loadLockedKitchen(id);
      if (kitchen) kitchenById[id] = kitchen;
    }

    const sourceKitchen = kitchenById[String(resolvedSourceRow.id)];
    const targetKitchen = kitchenById[String(resolvedTargetRow.id)];
    if (!sourceKitchen) {
      return { status: 404, payload: { ok: false, error: 'Source kitchen not found', message: '厨房不存在' } };
    }
    if (!targetKitchen) {
      return { status: 404, payload: { ok: false, error: 'Target kitchen not found', message: '当前厨房不存在' } };
    }

    const sourceRow = sourceKitchen.toJSON ? sourceKitchen.toJSON() : sourceKitchen;
    const targetRow = targetKitchen.toJSON ? targetKitchen.toJSON() : targetKitchen;
    const sourceInfo = normalizeKitchenInfo(sourceRow.id, parseJson(sourceRow.kitchenInfo, {}), sourceRow);
    const targetInfo = normalizeKitchenInfo(targetRow.id, parseJson(targetRow.kitchenInfo, {}), targetRow);
    if (!sourceInfo.isPublic) {
      return { status: 403, payload: { ok: false, error: 'Source kitchen is private', message: '该厨房已关闭公开，不能偷菜' } };
    }
    if (String(targetRow.ownerUserId) !== String(resolvedOperatorRow.id)) {
      return { status: 403, payload: { ok: false, error: 'Target kitchen forbidden', message: '只能偷到自己的当前厨房' } };
    }

    const sourceDishes = await loadLockedKitchenDishes(sourceRow);
    const targetDishes = await loadLockedKitchenDishes(targetRow);
    const sourceDish = sourceDishes.find(dish => String(dish && dish.id) === sourceDishId);
    if (!sourceDish) {
      return { status: 404, payload: { ok: false, error: 'Source dish not found', message: '这个菜已经不存在了' } };
    }

    const stolenRecords = normalizeStolenDishRecords(targetInfo.stolenDishes);
    const stolenKey = makeStolenDishKey(sourceRow.id, sourceDishId);
    const existingRecord = stolenRecords.find(record => makeStolenDishKey(record.sourceKitchenId, record.sourceDishId) === stolenKey);
    if (existingRecord) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: 'Dish already stolen',
          message: '这个菜已经偷过了',
          stolen: true,
          record: existingRecord
        }
      };
    }

    const targetCategories = getKitchenCategoryList(targetRow, targetDishes);
    if (targetCategory !== '未分类' && !targetCategories.includes(targetCategory)) {
      return { status: 400, payload: { ok: false, error: 'Target category invalid', message: '请选择当前厨房已有分类' } };
    }
    const nextCategories = targetCategories.includes(targetCategory)
      ? targetCategories
      : targetCategories.concat(targetCategory);

    const userIds = Array.from(new Set([resolvedOperatorRow.id, sourceRow.ownerUserId].filter(Boolean).map(id => String(id)))).sort();
    const userById = {};
    for (const id of userIds) {
      const user = await User.findByPk(id, { transaction, lock: true });
      if (user) userById[id] = user;
    }
    const operator = userById[String(resolvedOperatorRow.id)];
    if (!operator) {
      return { status: 404, payload: { ok: false, error: 'User not found', message: '用户不存在' } };
    }

    const stealCost = 200;
    const compensation = 100;
    const operatorRow = operator.toJSON ? operator.toJSON() : operator;
    const operatorBalance = formatCabbageNumber(operatorRow.cabbageBalance, 2200.00);
    if (operatorBalance < stealCost) {
      return { status: 409, payload: { ok: false, error: 'Insufficient balance', message: '大白菜不足，偷菜需要 200 大白菜' } };
    }

    const owner = userById[String(sourceRow.ownerUserId)] || null;
    const ownerRow = owner && owner.toJSON ? owner.toJSON() : owner;
    const ownerBalance = owner ? formatCabbageNumber(ownerRow.cabbageBalance, 2200.00) : 0;
    const sameBalanceUser = owner && String(ownerRow.id) === String(operatorRow.id);
    const nextOperatorBalance = formatCabbageNumber(operatorBalance - stealCost, 0);
    const nextOwnerBalance = formatCabbageNumber(ownerBalance + compensation, 0);
    const nextSameUserBalance = formatCabbageNumber(operatorBalance - stealCost + compensation, 0);
    const sourceKitchenName = sourceInfo.name || `厨房${sourceRow.id}`;
    const targetKitchenName = targetInfo.name || `厨房${targetRow.id}`;
    const dishName = String(sourceDish.name || '菜品').trim() || '菜品';
    const stolenAt = new Date().toISOString();
    const targetDishId = makeId('dish');
    const stolenDish = stealDishForKitchen(sourceDish, targetCategory, {
      targetDishId,
      sourceKitchenId: sourceRow.id,
      sourceKitchenName,
      stolenAt
    });
    const nextDishes = targetDishes.concat(stolenDish);
    const nextRecord = {
      id: makeId('steal'),
      sourceKitchenId: String(sourceRow.id),
      sourceDishId,
      targetDishId,
      sourceKitchenName,
      dishName,
      targetCategory,
      cost: formatCabbageNumberText(stealCost, 0),
      compensation: formatCabbageNumberText(compensation, 0),
      stolenAt
    };
    const nextTargetInfo = {
      ...targetInfo,
      stolenDishes: [nextRecord].concat(stolenRecords)
    };

    const operatorHistory = parseUserCabbageHistory(operatorRow, operatorBalance);
    const ownerHistory = owner ? parseUserCabbageHistory(ownerRow, ownerBalance) : [];
    const nextOperatorHistory = sameBalanceUser
      ? [
          makeCabbageHistoryEntry('add', compensation, `偷菜补偿(${dishName}|偷菜方:${targetKitchenName}|被偷方:${sourceKitchenName})`, nextSameUserBalance),
          makeCabbageHistoryEntry('sub', stealCost, `偷菜消耗(${dishName}|偷菜方:${targetKitchenName}|被偷方:${sourceKitchenName})`, nextOperatorBalance),
          ...operatorHistory
        ]
      : [
          makeCabbageHistoryEntry('sub', stealCost, `偷菜消耗(${dishName}|偷菜方:${targetKitchenName}|被偷方:${sourceKitchenName})`, nextOperatorBalance),
          ...operatorHistory
        ];
    const nextOwnerHistory = owner
      ? [
          makeCabbageHistoryEntry('add', compensation, `偷菜补偿(${dishName}|偷菜方:${targetKitchenName}|被偷方:${sourceKitchenName})`, nextOwnerBalance),
          ...ownerHistory
        ]
      : ownerHistory;

    await operator.update({
      cabbageBalance: sameBalanceUser ? nextSameUserBalance : nextOperatorBalance,
      cabbageHistory: stringifyJson(nextOperatorHistory, [])
    }, { transaction });
    if (owner && !sameBalanceUser) {
      await owner.update({
        cabbageBalance: nextOwnerBalance,
        cabbageHistory: stringifyJson(nextOwnerHistory, [])
      }, { transaction });
    }
    await targetKitchen.update({
      kitchenInfo: stringifyJson(nextTargetInfo, {}),
      categories: stringifyJson(nextCategories, []),
      dishes: stringifyJson(nextDishes, [])
    }, { transaction });
    await Dish.destroy({
      where: { kitchenId: targetRow.id },
      transaction
    });
    if (nextDishes.length > 0) {
      await Dish.bulkCreate(
        nextDishes.map((dish, index) => toDishRow(targetRow.id, targetRow.ownerUserId, dish, index)),
        { transaction }
      );
    }

    return {
      status: 200,
      sourceKitchenId: sourceRow.id,
      targetKitchenId: targetRow.id,
      operatorId: operatorRow.id,
      ownerId: ownerRow ? ownerRow.id : '',
      targetDishId,
      sourceDishId,
      cost: formatCabbageNumberText(stealCost, 0),
      compensation: formatCabbageNumberText(compensation, 0),
      record: nextRecord
    };
  });

  if (!stealResult || stealResult.status !== 200) {
    const failure = stealResult || { status: 500, payload: { ok: false, error: 'Steal dish failed', message: '偷菜失败' } };
    res.status(failure.status).send(failure.payload);
    return;
  }

  const operator = await User.findByPk(stealResult.operatorId);
  const owner = stealResult.ownerId ? await User.findByPk(stealResult.ownerId) : null;
  const refreshedTargetKitchen = await findKitchenByIdOrLegacy(stealResult.targetKitchenId);

  res.send({
    ok: true,
    sourceKitchenId: stealResult.sourceKitchenId,
    targetKitchenId: stealResult.targetKitchenId,
    sourceDishId: stealResult.sourceDishId,
    targetDishId: stealResult.targetDishId,
    cost: stealResult.cost,
    compensation: stealResult.compensation,
    record: stealResult.record,
    user: await toClientUserWithDecoratedHistory(operator),
    owner: owner ? await toClientUserWithDecoratedHistory(owner) : null,
    ...(await toClientState(refreshedTargetKitchen))
  });
}));

app.post('/api/kitchens/:id/clone', asyncHandler(async (req, res) => {
  const sourceKitchenId = String(req.params.id || '').trim();
  const body = req.body || {};
  const operatorUserId = String(body.userId || body.clientUserId || getRequestUserId(req, body) || '').trim();
  const targetKitchenId = String(body.targetKitchenId || '').trim();

  if (!sourceKitchenId || !targetKitchenId || !operatorUserId) {
    res.status(400).send({ ok: false, error: 'Clone kitchen required' });
    return;
  }

  const resolvedOperator = await findUserByIdOrLoginKey(operatorUserId);
  if (!resolvedOperator) {
    res.status(404).send({ ok: false, error: 'User not found', message: '用户不存在' });
    return;
  }

  const resolvedSourceKitchen = await findKitchenByIdOrLegacy(sourceKitchenId);
  if (!resolvedSourceKitchen) {
    res.status(404).send({ ok: false, error: 'Source kitchen not found', message: '厨房不存在' });
    return;
  }

  const resolvedTargetKitchen = await findKitchenByIdOrLegacy(targetKitchenId);
  if (!resolvedTargetKitchen) {
    res.status(404).send({ ok: false, error: 'Target kitchen not found', message: '当前厨房不存在' });
    return;
  }

  const resolvedOperatorRow = resolvedOperator.toJSON ? resolvedOperator.toJSON() : resolvedOperator;
  const resolvedSourceRow = resolvedSourceKitchen.toJSON ? resolvedSourceKitchen.toJSON() : resolvedSourceKitchen;
  const resolvedTargetRow = resolvedTargetKitchen.toJSON ? resolvedTargetKitchen.toJSON() : resolvedTargetKitchen;
  if (String(resolvedSourceRow.id) === String(resolvedTargetRow.id)) {
    res.status(409).send({ ok: false, error: 'Cannot clone current kitchen', message: '不能克隆当前厨房' });
    return;
  }

  const cloneResult = await sequelize.transaction(async transaction => {
    const loadLockedKitchen = async id => Kitchen.findOne({
      where: { id, dissolvedAt: null },
      transaction,
      lock: true
    });
    const loadLockedKitchenDishes = async row => {
      const legacyDishes = normalizeDishList(row.dishes);
      const rows = await Dish.findAll({
        where: { kitchenId: row.id },
        order: [['sortIndex', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']],
        transaction,
        lock: true
      });
      return rows.length > 0 ? rows.map(toClientDish) : legacyDishes;
    };

    const kitchenIds = Array.from(new Set([resolvedSourceRow.id, resolvedTargetRow.id].map(id => String(id)))).sort();
    const kitchenById = {};
    for (const id of kitchenIds) {
      const kitchen = await loadLockedKitchen(id);
      if (kitchen) kitchenById[id] = kitchen;
    }

    const sourceKitchen = kitchenById[String(resolvedSourceRow.id)];
    const targetKitchen = kitchenById[String(resolvedTargetRow.id)];
    if (!sourceKitchen) {
      return { status: 404, payload: { ok: false, error: 'Source kitchen not found', message: '厨房不存在' } };
    }
    if (!targetKitchen) {
      return { status: 404, payload: { ok: false, error: 'Target kitchen not found', message: '当前厨房不存在' } };
    }

    const sourceRow = sourceKitchen.toJSON ? sourceKitchen.toJSON() : sourceKitchen;
    const targetRow = targetKitchen.toJSON ? targetKitchen.toJSON() : targetKitchen;
    const sourceInfo = normalizeKitchenInfo(sourceRow.id, parseJson(sourceRow.kitchenInfo, {}), sourceRow);
    if (!sourceInfo.isPublic) {
      return { status: 403, payload: { ok: false, error: 'Source kitchen is private', message: '该厨房未公开，不能克隆' } };
    }
    if (String(targetRow.ownerUserId) !== String(resolvedOperatorRow.id)) {
      return { status: 403, payload: { ok: false, error: 'Target kitchen forbidden', message: '只能克隆到自己的当前厨房' } };
    }

    const userIds = Array.from(new Set([resolvedOperatorRow.id, sourceRow.ownerUserId].filter(Boolean).map(id => String(id)))).sort();
    const userById = {};
    for (const id of userIds) {
      const user = await User.findByPk(id, { transaction, lock: true });
      if (user) userById[id] = user;
    }
    const operator = userById[String(resolvedOperatorRow.id)];
    if (!operator) {
      return { status: 404, payload: { ok: false, error: 'User not found', message: '用户不存在' } };
    }

    const operatorRow = operator.toJSON ? operator.toJSON() : operator;
    const sourceDishes = await loadLockedKitchenDishes(sourceRow);
    const targetDishes = await loadLockedKitchenDishes(targetRow);
    const sourceCategories = getKitchenCategoryList(sourceRow, sourceDishes);
    const targetCategories = getKitchenCategoryList(targetRow, targetDishes);
    const nextCategories = mergeKitchenCategories(targetCategories, sourceCategories);
    const clonedDishes = sourceDishes.map(cloneDishForKitchen);
    const nextDishes = targetDishes.concat(clonedDishes);
    const cloneCost = sourceDishes.length * 200;
    const compensation = Math.floor(cloneCost / 2);
    const operatorBalance = formatCabbageNumber(operatorRow.cabbageBalance, 2200.00);
    if (operatorBalance < cloneCost) {
      return { status: 409, payload: { ok: false, error: 'Insufficient balance', message: '大白菜余额不足' } };
    }

    const owner = userById[String(sourceRow.ownerUserId)] || null;
    const ownerRow = owner && owner.toJSON ? owner.toJSON() : owner;
    const ownerBalance = owner ? formatCabbageNumber(ownerRow.cabbageBalance, 2200.00) : 0;
    const sameBalanceUser = owner && String(ownerRow.id) === String(operatorRow.id);
    const nextOperatorBalance = formatCabbageNumber(operatorBalance - cloneCost, 0);
    const nextOwnerBalance = formatCabbageNumber(ownerBalance + compensation, 0);
    const nextSameUserBalance = formatCabbageNumber(operatorBalance - cloneCost + compensation, 0);
    const sourceKitchenName = sourceInfo.name || `厨房${sourceRow.id}`;
    const operatorHistory = parseUserCabbageHistory(operatorRow, operatorBalance);
    const ownerHistory = owner ? parseUserCabbageHistory(ownerRow, ownerBalance) : [];
    const nextOperatorHistory = sameBalanceUser
      ? [
          ...(compensation > 0 ? [makeCabbageHistoryEntry('add', compensation, `厨房被克隆-补偿(${sourceKitchenName})`, nextSameUserBalance)] : []),
          ...(cloneCost > 0 ? [makeCabbageHistoryEntry('sub', cloneCost, `克隆厨房-消耗(${sourceKitchenName})`, nextOperatorBalance)] : []),
          ...operatorHistory
        ]
      : (cloneCost > 0
      ? [
          makeCabbageHistoryEntry('sub', cloneCost, `克隆厨房-消耗(${sourceKitchenName})`, nextOperatorBalance),
          ...operatorHistory
        ]
      : operatorHistory);
    const nextOwnerHistory = owner && compensation > 0
      ? [
          makeCabbageHistoryEntry('add', compensation, `厨房被克隆-补偿(${sourceKitchenName})`, nextOwnerBalance),
          ...ownerHistory
        ]
      : ownerHistory;

    await operator.update({
      cabbageBalance: sameBalanceUser ? nextSameUserBalance : nextOperatorBalance,
      cabbageHistory: stringifyJson(nextOperatorHistory, [])
    }, { transaction });
    if (owner && !sameBalanceUser && compensation > 0) {
      await owner.update({
        cabbageBalance: nextOwnerBalance,
        cabbageHistory: stringifyJson(nextOwnerHistory, [])
      }, { transaction });
    }
    await targetKitchen.update({
      categories: stringifyJson(nextCategories, []),
      dishes: stringifyJson(nextDishes, [])
    }, { transaction });
    await Dish.destroy({
      where: { kitchenId: targetRow.id },
      transaction
    });
    if (nextDishes.length > 0) {
      await Dish.bulkCreate(
        nextDishes.map((dish, index) => toDishRow(targetRow.id, targetRow.ownerUserId, dish, index)),
        { transaction }
      );
    }

    return {
      status: 200,
      sourceKitchenId: sourceRow.id,
      targetKitchenId: targetRow.id,
      operatorId: operatorRow.id,
      ownerId: ownerRow ? ownerRow.id : '',
      clonedDishCount: clonedDishes.length,
      addedCategoryCount: nextCategories.length - targetCategories.length,
      cloneCost: formatCabbageNumberText(cloneCost, 0),
      compensation: formatCabbageNumberText(compensation, 0)
    };
  });

  if (!cloneResult || cloneResult.status !== 200) {
    const failure = cloneResult || { status: 500, payload: { ok: false, error: 'Clone kitchen failed', message: '克隆失败' } };
    res.status(failure.status).send(failure.payload);
    return;
  }

  const operator = await User.findByPk(cloneResult.operatorId);
  const owner = cloneResult.ownerId ? await User.findByPk(cloneResult.ownerId) : null;
  const refreshedTargetKitchen = await findKitchenByIdOrLegacy(cloneResult.targetKitchenId);

  res.send({
    ok: true,
    sourceKitchenId: cloneResult.sourceKitchenId,
    targetKitchenId: cloneResult.targetKitchenId,
    clonedDishCount: cloneResult.clonedDishCount,
    addedCategoryCount: cloneResult.addedCategoryCount,
    cloneCost: cloneResult.cloneCost,
    compensation: cloneResult.compensation,
    user: await toClientUserWithDecoratedHistory(operator),
    owner: owner ? await toClientUserWithDecoratedHistory(owner) : null,
    ...(await toClientState(refreshedTargetKitchen))
  });
}));

app.get('/api/debug/session-switch-data', asyncHandler(async (req, res) => {
  const users = await User.findAll({
    attributes: ['id', 'openid', 'nickname', 'avatar', 'defaultOrderNote', 'cabbageBalance', 'updatedAt'],
    order: [['updatedAt', 'DESC']]
  });
  const kitchens = await Kitchen.findAll({
    attributes: ['id', 'ownerUserId', 'legacyId', 'kitchenCode', 'kitchenInfo', 'dishes', 'createdAt', 'updatedAt'],
    where: { dissolvedAt: null },
    order: [['updatedAt', 'DESC']]
  });

  const kitchenCountByUserId = kitchens.reduce((map, kitchen) => {
    const ownerUserId = kitchen.ownerUserId || '';
    map[ownerUserId] = (map[ownerUserId] || 0) + 1;
    return map;
  }, {});

  const kitchenRows = await Promise.all(kitchens.map(async kitchen => ({
    ...(await toClientKitchenSummary(kitchen)),
    announcement: parseJson((kitchen.toJSON ? kitchen.toJSON() : kitchen).kitchenInfo, {}).announcement || '',
    updatedAt: (kitchen.toJSON ? kitchen.toJSON() : kitchen).updatedAt || null
  })));
  const kitchensByUserId = kitchenRows.reduce((map, kitchen) => {
    const ownerUserId = String(kitchen.ownerUserId || '');
    if (!ownerUserId) return map;
    if (!map[ownerUserId]) map[ownerUserId] = [];
    map[ownerUserId].push(kitchen);
    return map;
  }, {});

  res.send({
    users: users.map(user => {
      const row = user.toJSON ? user.toJSON() : user;
      const userKitchens = kitchensByUserId[String(row.id)] || [];
      return {
        id: row.id,
        openid: row.openid || '',
        nickname: row.nickname || '',
        avatar: row.avatar || '',
        defaultOrderNote: row.defaultOrderNote || '',
        cabbageBalance: formatCabbageNumberText(row.cabbageBalance, 2200.00),
        kitchenCount: userKitchens.length || kitchenCountByUserId[row.id] || 0,
        kitchens: userKitchens,
        updatedAt: row.updatedAt || null
      };
    }),
    kitchens: kitchenRows
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
    const kitchenCode = await makeKitchenCode(
      isKitchenCode(requestedKitchenId) ? requestedKitchenId : '',
      kitchenId
    );
    const options = requestedKitchenId && requestedKitchenId !== kitchenId
      ? { legacyId: requestedKitchenId, kitchenCode }
      : { kitchenCode };
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
  const kitchenCode = current
    ? await ensureKitchenCode(current)
    : await makeKitchenCode(
        isKitchenCode(requestedKitchenId)
          ? requestedKitchenId
          : (((body.state || {}).kitchenInfo && (body.state || {}).kitchenInfo.kitchenCode) || (body.state || {}).kitchenCode || ''),
        kitchenId
      );
  const options = !current && requestedKitchenId && requestedKitchenId !== kitchenId
    ? { legacyId: requestedKitchenId, kitchenCode }
    : { kitchenCode };
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

app.delete('/api/kitchens/:id', asyncHandler(async (req, res) => {
  const requestedKitchenId = String(req.params.id || '').trim();
  const body = req.body || {};
  if (!requestedKitchenId) {
    res.status(400).send({ ok: false, error: 'Invalid kitchenId', message: '厨房 ID 不能为空' });
    return;
  }

  // 软删除需要能查到包括已解散的厨房，这里不能用过滤了 dissolvedAt 的 findKitchenByIdOrLegacy。
  let kitchen = await Kitchen.findByPk(requestedKitchenId);
  if (!kitchen) {
    kitchen = await Kitchen.findOne({ where: { kitchenCode: requestedKitchenId } });
  }
  if (!kitchen) {
    kitchen = await Kitchen.findOne({ where: { legacyId: requestedKitchenId } });
  }
  if (!kitchen) {
    res.status(404).send({ ok: false, error: 'Kitchen not found', message: '厨房不存在或已解散' });
    return;
  }

  // 权限校验：只能解散自己拥有的厨房。
  const operatorUserId = body.userId || getRequestUserId(req, body);
  if (!operatorUserId || String(kitchen.ownerUserId) !== String(operatorUserId)) {
    res.status(403).send({ ok: false, error: 'Forbidden', message: '只能解散自己的厨房' });
    return;
  }

  // 幂等：已经软删除过就直接返回成功。
  if (kitchen.dissolvedAt) {
    res.send({
      ok: true,
      kitchenId: kitchen.id,
      dissolvedAt: kitchen.dissolvedAt,
      alreadyDissolved: true
    });
    return;
  }

  const now = new Date();
  await kitchen.update({ dissolvedAt: now });

  // 软删除同步标记到 kitchenInfo，方便前端和历史快照识别。
  try {
    const info = parseJson(kitchen.kitchenInfo, {});
    info.dissolvedAt = now;
    info.dissolved = true;
    await kitchen.update({ kitchenInfo: stringifyJson(info, kitchen.kitchenInfo) });
  } catch (err) {
    console.warn('解散厨房时回写 kitchenInfo 失败', err && err.message ? err.message : err);
  }

  res.send({ ok: true, kitchenId: kitchen.id, dissolvedAt: now });
}));

app.get('/api/users/:id/dissolved-kitchens', asyncHandler(async (req, res) => {
  const userId = String(req.params.id || '').trim();
  const operatorUserId = String(req.query.userId || req.headers['x-debug-user-id'] || userId || '').trim();
  if (!userId || String(userId) !== String(operatorUserId)) {
    res.status(403).send({ ok: false, error: 'Forbidden', message: '只能查看自己的已解散厨房' });
    return;
  }

  const kitchens = await Kitchen.findAll({
    where: { ownerUserId: userId, dissolvedAt: { [require('sequelize').Op.ne]: null } },
    order: [['dissolvedAt', 'DESC'], ['updatedAt', 'DESC'], ['id', 'DESC']]
  });

  const list = await Promise.all(kitchens.map(async kitchen => {
    const summary = await toClientKitchenSummary(kitchen);
    const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
    return {
      ...summary,
      dissolvedAt: row.dissolvedAt
    };
  }));

  res.send({ userId, kitchens: list });
}));

app.post('/api/kitchens/:id/restore', asyncHandler(async (req, res) => {
  const requestedKitchenId = String(req.params.id || '').trim();
  const body = req.body || {};
  if (!requestedKitchenId) {
    res.status(400).send({ ok: false, error: 'Invalid kitchenId', message: '厨房 ID 不能为空' });
    return;
  }

  // 恢复需要查到已解散的厨房，不能用过滤了 dissolvedAt 的 findKitchenByIdOrLegacy。
  let kitchen = await Kitchen.findByPk(requestedKitchenId);
  if (!kitchen) {
    kitchen = await Kitchen.findOne({ where: { kitchenCode: requestedKitchenId } });
  }
  if (!kitchen) {
    kitchen = await Kitchen.findOne({ where: { legacyId: requestedKitchenId } });
  }
  if (!kitchen) {
    res.status(404).send({ ok: false, error: 'Kitchen not found', message: '厨房不存在' });
    return;
  }

  const operatorUserId = body.userId || getRequestUserId(req, body);
  if (!operatorUserId || String(kitchen.ownerUserId) !== String(operatorUserId)) {
    res.status(403).send({ ok: false, error: 'Forbidden', message: '只能恢复自己的厨房' });
    return;
  }

  // 幂等：未软删除直接返回成功。
  if (!kitchen.dissolvedAt) {
    res.send({ ok: true, kitchenId: kitchen.id, alreadyActive: true });
    return;
  }

  await kitchen.update({ dissolvedAt: null });

  try {
    const info = parseJson(kitchen.kitchenInfo, {});
    delete info.dissolvedAt;
    delete info.dissolved;
    await kitchen.update({ kitchenInfo: stringifyJson(info, kitchen.kitchenInfo) });
  } catch (err) {
    console.warn('恢复厨房时回写 kitchenInfo 失败', err && err.message ? err.message : err);
  }

  const summary = await toClientKitchenSummary(kitchen);
  res.send({ ok: true, kitchenId: kitchen.id, kitchen: summary });
}));

app.delete('/api/kitchens/:id/permanent', asyncHandler(async (req, res) => {
  const requestedKitchenId = String(req.params.id || '').trim();
  const body = req.body || {};
  if (!requestedKitchenId) {
    res.status(400).send({ ok: false, error: 'Invalid kitchenId', message: '厨房 ID 不能为空' });
    return;
  }

  let kitchen = await Kitchen.findByPk(requestedKitchenId);
  if (!kitchen) {
    kitchen = await Kitchen.findOne({ where: { kitchenCode: requestedKitchenId } });
  }
  if (!kitchen) {
    kitchen = await Kitchen.findOne({ where: { legacyId: requestedKitchenId } });
  }
  if (!kitchen) {
    res.status(404).send({ ok: false, error: 'Kitchen not found', message: '厨房不存在' });
    return;
  }

  const operatorUserId = body.userId || getRequestUserId(req, body);
  if (!operatorUserId || String(kitchen.ownerUserId) !== String(operatorUserId)) {
    res.status(403).send({ ok: false, error: 'Forbidden', message: '只能永久删除自己的厨房' });
    return;
  }

  if (!kitchen.dissolvedAt) {
    res.status(409).send({ ok: false, error: 'Kitchen is active', message: '请先解散厨房后再永久删除' });
    return;
  }

  const row = kitchen.toJSON ? kitchen.toJSON() : kitchen;
  const kitchenIds = Array.from(new Set([
    row.id,
    row.legacyId,
    row.kitchenCode,
    requestedKitchenId
  ].filter(id => String(id || '').trim()).map(id => String(id).trim())));

  let deletedOrders = 0;
  let deletedDishes = 0;
  await sequelize.transaction(async transaction => {
    deletedOrders = await Order.destroy({
      where: { kitchenId: { [Op.in]: kitchenIds } },
      transaction
    });
    deletedDishes = await Dish.destroy({
      where: { kitchenId: { [Op.in]: kitchenIds } },
      transaction
    });
    await kitchen.destroy({ transaction });
  });

  res.send({
    ok: true,
    kitchenId: row.id,
    deleted: {
      kitchens: 1,
      orders: deletedOrders,
      dishes: deletedDishes
    }
  });
}));

app.get('/api/life-shares', asyncHandler(async (req, res) => {
  const filter = String(req.query.filter || 'latest').trim();
  const requestUserId = getOptionalRequestUserId(req, req.query || {});
  const currentUser = requestUserId ? await findUserByIdOrLoginKey(requestUserId) : null;
  const currentUserId = currentUser ? String((currentUser.toJSON ? currentUser.toJSON() : currentUser).id || '') : '';
  const where = { status: 'visible' };

  if (filter === 'mine') {
    if (!currentUserId) {
      res.send({ posts: [] });
      return;
    }
    where.authorUserId = currentUserId;
  }

  if (filter === 'liked') {
    if (!currentUserId) {
      res.send({ posts: [] });
      return;
    }
    const likes = await LifeShareLike.findAll({ where: { userId: currentUserId } });
    const postIds = likes.map(like => String((like.toJSON ? like.toJSON() : like).postId || '')).filter(Boolean);
    if (!postIds.length) {
      res.send({ posts: [] });
      return;
    }
    where.id = { [Op.in]: postIds };
  }

  if (filter === 'commented') {
    if (!currentUserId) {
      res.send({ posts: [] });
      return;
    }
    const comments = await LifeShareComment.findAll({ where: { userId: currentUserId, status: 'visible' } });
    const postIds = Array.from(new Set(comments.map(comment => String((comment.toJSON ? comment.toJSON() : comment).postId || '')).filter(Boolean)));
    if (!postIds.length) {
      res.send({ posts: [] });
      return;
    }
    where.id = { [Op.in]: postIds };
  }

  const rows = await LifeSharePost.findAll({
    where,
    order: filter === 'featured'
      ? [['viewCount', 'DESC'], ['createdAt', 'DESC']]
      : [['createdAt', 'DESC']]
  });
  const postIds = rows.map(row => String((row.toJSON ? row.toJSON() : row).id || ''));
  const userMap = await buildLifeShareUserMap(rows.map(row => (row.toJSON ? row.toJSON() : row).authorUserId));
  const likeCountMap = await buildLifeShareLikeCountMap(postIds);
  const commentCountMap = await buildLifeShareCommentCountMap(postIds);
  const likedSet = await buildCurrentUserLikedSet(postIds, currentUserId);
  let posts = await Promise.all(rows.map(row => toClientLifeSharePost(row, {
    userMap,
    likeCountMap,
    commentCountMap,
    likedSet
  })));

  if (filter === 'featured') {
    posts.sort((left, right) => {
      if (right.heatCount !== left.heatCount) return right.heatCount - left.heatCount;
      return right.createdAt - left.createdAt;
    });
  }

  res.send({ posts });
}));

app.post('/api/life-shares', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const user = await requireLifeShareUser(req, body);
  const userRow = user.toJSON ? user.toJSON() : user;
  const content = String(body.content || '').trim().slice(0, 500);
  const images = normalizeLifeShareImages(body.images);

  if (!content && images.length === 0) {
    res.status(400).send({ ok: false, error: 'Invalid content', message: '请输入生活分享内容或添加图片' });
    return;
  }

  const ipAddress = getClientIpText(req);
  const ipText = await getClientRegionText(req, ipAddress);
  logLifeShareIpDebug(req, ipAddress, ipText);
  const post = await LifeSharePost.create({
    id: makeId('life_post'),
    authorUserId: userRow.id,
    content,
    images: stringifyJson(images, []),
    ipText,
    ipAddress: ipAddress === '未知' ? '' : ipAddress,
    viewCount: 0,
    status: 'visible'
  });

  const userMap = await buildLifeShareUserMap([userRow.id]);
  res.send({
    ok: true,
    post: await toClientLifeSharePost(post, { userMap })
  });
}));

app.get('/api/life-shares/:id', asyncHandler(async (req, res) => {
  const postId = String(req.params.id || '').trim();
  const post = await LifeSharePost.findOne({ where: { id: postId, status: 'visible' } });
  if (!post) {
    res.status(404).send({ ok: false, error: 'Post not found', message: '分享内容不存在' });
    return;
  }

  const requestUserId = getOptionalRequestUserId(req, req.query || {});
  const currentUser = requestUserId ? await findUserByIdOrLoginKey(requestUserId) : null;
  const currentUserId = currentUser ? String((currentUser.toJSON ? currentUser.toJSON() : currentUser).id || '') : '';
  const comments = await LifeShareComment.findAll({
    where: { postId, status: 'visible' },
    order: [['createdAt', 'ASC']]
  });
  const postRow = post.toJSON ? post.toJSON() : post;
  const commentRows = comments.map(comment => (comment.toJSON ? comment.toJSON() : comment));
  const parentCommentIds = Array.from(new Set(commentRows.map(comment => String(comment.parentCommentId || '')).filter(Boolean)));
  const parentComments = parentCommentIds.length
    ? await LifeShareComment.findAll({ where: { id: { [Op.in]: parentCommentIds } } })
    : [];
  const parentCommentMap = parentComments.reduce((result, comment) => {
    const row = comment.toJSON ? comment.toJSON() : comment;
    result[String(row.id || '')] = row;
    return result;
  }, {});
  const commentUserIds = commentRows
    .map(comment => comment.userId)
    .concat(parentComments.map(comment => (comment.toJSON ? comment.toJSON() : comment).userId));
  const userMap = await buildLifeShareUserMap([postRow.authorUserId].concat(commentUserIds));
  const likeCountMap = await buildLifeShareLikeCountMap([postId]);
  const commentCountMap = await buildLifeShareCommentCountMap([postId]);
  const likedSet = await buildCurrentUserLikedSet([postId], currentUserId);
  const clientComments = await Promise.all(comments.map(comment => toClientLifeShareComment(comment, userMap, parentCommentMap)));

  res.send({
    post: await toClientLifeSharePost(post, {
      userMap,
      likeCountMap,
      commentCountMap,
      likedSet,
      comments: clientComments
    })
  });
}));

app.delete('/api/life-shares/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const postId = String(req.params.id || '').trim();
  const post = await LifeSharePost.findOne({ where: { id: postId, status: 'visible' } });
  if (!post) {
    res.status(404).send({ ok: false, error: 'Post not found', message: '分享内容不存在' });
    return;
  }

  const user = await requireLifeShareUser(req, body);
  const userId = String((user.toJSON ? user.toJSON() : user).id || '');
  const postRow = post.toJSON ? post.toJSON() : post;
  if (String(postRow.authorUserId || '') !== userId) {
    res.status(403).send({ ok: false, error: 'Forbidden', message: '只能删除自己发布的内容' });
    return;
  }

  await LifeShareLike.destroy({ where: { postId } });
  await LifeShareComment.destroy({ where: { postId } });
  await LifeShareNotification.destroy({ where: { postId } });
  await post.update({ status: 'deleted' });

  res.send({ ok: true, deletedId: postId });
}));

app.post('/api/life-shares/:id/view', asyncHandler(async (req, res) => {
  const postId = String(req.params.id || '').trim();
  const post = await LifeSharePost.findOne({ where: { id: postId, status: 'visible' } });
  if (!post) {
    res.status(404).send({ ok: false, error: 'Post not found', message: '分享内容不存在' });
    return;
  }

  await post.increment('viewCount', { by: 1 });
  await post.reload();
  const requestUserId = getOptionalRequestUserId(req, req.body || {});
  const currentUser = requestUserId ? await findUserByIdOrLoginKey(requestUserId) : null;
  const currentUserId = currentUser ? String((currentUser.toJSON ? currentUser.toJSON() : currentUser).id || '') : '';
  const postRow = post.toJSON ? post.toJSON() : post;
  const userMap = await buildLifeShareUserMap([postRow.authorUserId]);
  const likeCountMap = await buildLifeShareLikeCountMap([postId]);
  const commentCountMap = await buildLifeShareCommentCountMap([postId]);
  const likedSet = await buildCurrentUserLikedSet([postId], currentUserId);
  res.send({
    ok: true,
    post: await toClientLifeSharePost(post, {
      userMap,
      likeCountMap,
      commentCountMap,
      likedSet
    })
  });
}));

app.post('/api/life-shares/:id/like', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const postId = String(req.params.id || '').trim();
  const post = await LifeSharePost.findOne({ where: { id: postId, status: 'visible' } });
  if (!post) {
    res.status(404).send({ ok: false, error: 'Post not found', message: '分享内容不存在' });
    return;
  }
  const user = await requireLifeShareUser(req, body);
  const userId = String((user.toJSON ? user.toJSON() : user).id || '');
  const likeId = `${postId}:${userId}`;
  const existing = await LifeShareLike.findByPk(likeId);
  let liked = false;
  if (existing) {
    await existing.destroy();
  } else {
    await LifeShareLike.create({ id: likeId, postId, userId });
    liked = true;
    const postRow = post.toJSON ? post.toJSON() : post;
    await createLifeShareNotification({
      recipientUserId: postRow.authorUserId,
      actorUserId: userId,
      postId,
      type: 'like'
    });
  }

  const postRow = post.toJSON ? post.toJSON() : post;
  const userMap = await buildLifeShareUserMap([postRow.authorUserId]);
  const likeCountMap = await buildLifeShareLikeCountMap([postId]);
  const commentCountMap = await buildLifeShareCommentCountMap([postId]);
  const likedSet = liked ? new Set([postId]) : new Set();
  res.send({
    ok: true,
    liked,
    post: await toClientLifeSharePost(post, {
      userMap,
      likeCountMap,
      commentCountMap,
      likedSet
    })
  });
}));

app.post('/api/life-shares/:id/comments', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const postId = String(req.params.id || '').trim();
  const post = await LifeSharePost.findOne({ where: { id: postId, status: 'visible' } });
  if (!post) {
    res.status(404).send({ ok: false, error: 'Post not found', message: '分享内容不存在' });
    return;
  }
  const user = await requireLifeShareUser(req, body);
  const userId = String((user.toJSON ? user.toJSON() : user).id || '');
  const content = String(body.content || '').trim().slice(0, 300);
  const parentCommentId = String(body.parentCommentId || body.replyToCommentId || '').trim();
  if (!content) {
    res.status(400).send({ ok: false, error: 'Invalid comment', message: '请输入评论内容' });
    return;
  }
  let parentComment = null;
  if (parentCommentId) {
    parentComment = await LifeShareComment.findOne({ where: { id: parentCommentId, postId, status: 'visible' } });
    if (!parentComment) {
      res.status(404).send({ ok: false, error: 'Parent comment not found', message: '回复的评论不存在' });
      return;
    }
  }

  const comment = await LifeShareComment.create({
    id: makeId('life_comment'),
    postId,
    userId,
    parentCommentId: parentCommentId || null,
    content,
    status: 'visible'
  });
  const postRow = post.toJSON ? post.toJSON() : post;
  const parentCommentRow = parentComment ? (parentComment.toJSON ? parentComment.toJSON() : parentComment) : null;
  await createLifeShareNotification({
    recipientUserId: parentCommentRow ? parentCommentRow.userId : postRow.authorUserId,
    actorUserId: userId,
    postId,
    commentId: comment.id,
    parentCommentId: parentCommentId || '',
    type: parentCommentRow ? 'reply' : 'comment',
    content
  });
  const userMap = await buildLifeShareUserMap([postRow.authorUserId, userId, parentCommentRow && parentCommentRow.userId]);
  const parentCommentMap = parentCommentRow ? { [String(parentCommentRow.id || '')]: parentCommentRow } : {};
  const clientComment = await toClientLifeShareComment(comment, userMap, parentCommentMap);
  const likeCountMap = await buildLifeShareLikeCountMap([postId]);
  const commentCountMap = await buildLifeShareCommentCountMap([postId]);
  const likedSet = await buildCurrentUserLikedSet([postId], userId);

  res.send({
    ok: true,
    comment: clientComment,
    post: await toClientLifeSharePost(post, {
      userMap,
      likeCountMap,
      commentCountMap,
      likedSet
    })
  });
}));

app.get('/api/life-share-notifications', asyncHandler(async (req, res) => {
  const requestUserId = getOptionalRequestUserId(req, req.query || {});
  const user = await findUserByIdOrLoginKey(requestUserId);
  if (!user) {
    res.status(401).send({ ok: false, error: 'User not found', message: '请先登录后再查看通知' });
    return;
  }
  const userId = String((user.toJSON ? user.toJSON() : user).id || '');
  const filter = String(req.query.filter || 'all').trim();
  const unreadOnly = String(req.query.unreadOnly || '') === '1';
  const markRead = String(req.query.markRead || '') === '1';
  const where = {
    recipientUserId: userId,
    status: 'visible'
  };
  if (unreadOnly) {
    where.readStatus = 'unread';
  }
  if (['like', 'comment', 'reply'].includes(filter)) {
    where.type = filter;
  }
  const rows = await LifeShareNotification.findAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: 100
  });
  const actorIds = rows.map(row => (row.toJSON ? row.toJSON() : row).actorUserId);
  const postIds = rows.map(row => (row.toJSON ? row.toJSON() : row).postId);
  const userMap = await buildLifeShareUserMap(actorIds);
  const postMap = await buildLifeSharePostMap(postIds);
  const notifications = await Promise.all(rows.map(row => toClientLifeShareNotification(row, { userMap, postMap })));
  if (markRead && !unreadOnly) {
    await LifeShareNotification.update(
      { readStatus: 'read' },
      { where: { recipientUserId: userId, status: 'visible', readStatus: 'unread' } }
    );
  }
  res.send({ notifications });
}));

app.delete('/api/life-share-notifications/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const requestUserId = getOptionalRequestUserId(req, body);
  const user = await findUserByIdOrLoginKey(requestUserId);
  if (!user) {
    res.status(401).send({ ok: false, error: 'User not found', message: '请先登录后再操作' });
    return;
  }
  const userId = String((user.toJSON ? user.toJSON() : user).id || '');
  const id = String(req.params.id || '').trim();
  const count = await LifeShareNotification.update(
    { status: 'deleted' },
    { where: { id, recipientUserId: userId, status: 'visible' } }
  );
  res.send({ ok: true, deleted: Array.isArray(count) ? Number(count[0] || 0) : 0 });
}));

app.delete('/api/life-share-notifications', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const requestUserId = getOptionalRequestUserId(req, body);
  const user = await findUserByIdOrLoginKey(requestUserId);
  if (!user) {
    res.status(401).send({ ok: false, error: 'User not found', message: '请先登录后再操作' });
    return;
  }
  const userId = String((user.toJSON ? user.toJSON() : user).id || '');
  const filter = String(body.filter || req.query.filter || 'all').trim();
  const where = { recipientUserId: userId, status: 'visible' };
  if (['like', 'comment', 'reply'].includes(filter)) {
    where.type = filter;
  }
  const count = await LifeShareNotification.update({ status: 'deleted' }, { where });
  res.send({ ok: true, deleted: Array.isArray(count) ? Number(count[0] || 0) : 0 });
}));

app.use((err, req, res, next) => {
  console.error('接口执行失败', err);
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).send({
    ok: false,
    error: err.name || 'Error',
    message: err.clientMessage || err.message || 'server error'
  });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  const cleanupResult = await cleanupLegacySoftDeletedOrders();
  console.log('历史软删除订单清理完成', cleanupResult);
  app.listen(port, () => {
    console.log('启动成功', port);
  });
}

bootstrap().catch(err => {
  console.error('启动失败', err);
  process.exit(1);
});
