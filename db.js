const { Sequelize, DataTypes } = require('sequelize');

const {
  MYSQL_USERNAME,
  MYSQL_PASSWORD,
  MYSQL_ADDRESS = '',
  MYSQL_DATABASE = 'nodejs_demo'
} = process.env;

const [host, port] = MYSQL_ADDRESS.split(':');

const sequelize = new Sequelize(MYSQL_DATABASE, MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: 'mysql',
  dialectOptions: {
    charset: 'utf8mb4'
  },
  logging: false,
  define: {
    freezeTableName: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  }
});

const User = sequelize.define('JrshUser', {
  id: {
    type: DataTypes.STRING(128),
    primaryKey: true
  },
  openid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    unique: true
  },
  nickname: {
    type: DataTypes.STRING(100),
    allowNull: false,
    defaultValue: '吃货玩家'
  },
  avatar: {
    type: DataTypes.TEXT('long'),
    allowNull: true
  },
  defaultOrderNote: {
    type: DataTypes.STRING(300),
    allowNull: true,
    defaultValue: ''
  },
  cabbageBalance: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    defaultValue: 2200.00
  },
  cabbageHistory: {
    type: DataTypes.TEXT('long'),
    allowNull: true
  },
  signState: {
    type: DataTypes.TEXT('long'),
    allowNull: true
  }
});

const Kitchen = sequelize.define('JrshKitchen', {
  id: {
    type: DataTypes.STRING(128),
    primaryKey: true
  },
  legacyId: {
    type: DataTypes.STRING(128),
    allowNull: true,
    unique: true
  },
  kitchenCode: {
    type: DataTypes.STRING(6),
    allowNull: true,
    unique: true
  },
  ownerUserId: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  kitchenInfo: {
    type: DataTypes.TEXT('long'),
    allowNull: false
  },
  categories: {
    type: DataTypes.TEXT('long'),
    allowNull: false
  },
  dishes: {
    type: DataTypes.TEXT('long'),
    allowNull: false
  },
  orders: {
    type: DataTypes.TEXT('long'),
    allowNull: false
  },
  lastQueueCode: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  isPublic: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  businessOpen: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  businessStart: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: '00:00'
  },
  businessEnd: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: '23:59'
  },
  displaySettings: {
    type: DataTypes.TEXT('long'),
    allowNull: true
  },
  dissolvedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  }
});

const Order = sequelize.define('JrshOrder', {
  id: {
    type: DataTypes.STRING(128),
    primaryKey: true
  },
  kitchenId: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  ownerUserId: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: true
  },
  queueCode: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  total: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  time: {
    type: DataTypes.STRING(32),
    allowNull: true
  },
  timeFull: {
    type: DataTypes.STRING(32),
    allowNull: true
  },
  userNickname: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  orderedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  payload: {
    type: DataTypes.TEXT('long'),
    allowNull: false
  }
});

const Dish = sequelize.define('JrshDish', {
  id: {
    type: DataTypes.STRING(128),
    primaryKey: true
  },
  dishId: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  kitchenId: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  ownerUserId: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  category: {
    type: DataTypes.STRING(128),
    allowNull: true
  },
  name: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  price: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: true
  },
  stars: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  stock: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  sales: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  sortIndex: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  payload: {
    type: DataTypes.TEXT('long'),
    allowNull: false
  }
});

function quoteIdentifier(value) {
  return `\`${String(value || '').replace(/`/g, '``')}\``;
}

function isDuplicateColumnError(err) {
  return err && (err.errno === 1060 || err.original && err.original.errno === 1060);
}

async function columnExists(table, column) {
  const [rows] = await sequelize.query(
    `SHOW COLUMNS FROM ${quoteIdentifier(table)} LIKE ${sequelize.escape(column)}`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function addColumnIfMissing(table, column, definition) {
  try {
    if (await columnExists(table, column)) return;
    await sequelize.query(
      `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`
    );
  } catch (err) {
    if (isDuplicateColumnError(err)) return;
    throw err;
  }
}

async function ensureRequiredColumns() {
  await addColumnIfMissing('JrshUser', 'defaultOrderNote', "VARCHAR(300) NULL DEFAULT ''");
  await addColumnIfMissing('JrshUser', 'cabbageBalance', 'DECIMAL(12,2) NOT NULL DEFAULT 2200.00');
  await addColumnIfMissing('JrshUser', 'cabbageHistory', 'LONGTEXT NULL');
  await addColumnIfMissing('JrshUser', 'signState', 'LONGTEXT NULL');

  await addColumnIfMissing('JrshKitchen', 'legacyId', 'VARCHAR(128) NULL');
  await addColumnIfMissing('JrshKitchen', 'kitchenCode', 'VARCHAR(6) NULL');
  await addColumnIfMissing('JrshKitchen', 'lastQueueCode', 'INTEGER NULL');
  await addColumnIfMissing('JrshKitchen', 'isPublic', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('JrshKitchen', 'businessOpen', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('JrshKitchen', 'businessStart', "VARCHAR(8) NOT NULL DEFAULT '00:00'");
  await addColumnIfMissing('JrshKitchen', 'businessEnd', "VARCHAR(8) NOT NULL DEFAULT '23:59'");
  await addColumnIfMissing('JrshKitchen', 'displaySettings', 'LONGTEXT NULL');
  await addColumnIfMissing('JrshKitchen', 'dissolvedAt', 'DATETIME NULL');

  await addColumnIfMissing('JrshOrder', 'orderedAt', 'DATETIME NULL');
  await addColumnIfMissing('JrshOrder', 'payload', 'LONGTEXT NULL');

  await addColumnIfMissing('JrshDish', 'sortIndex', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('JrshDish', 'payload', 'LONGTEXT NULL');
}

async function ensureUtf8mb4() {
  const tables = ['JrshUser', 'JrshKitchen', 'JrshOrder', 'JrshDish'];
  try {
    await sequelize.query(`ALTER DATABASE ${quoteIdentifier(MYSQL_DATABASE)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (err) {
    console.warn('ensure database utf8mb4 failed', err && err.message ? err.message : err);
  }

  for (const table of tables) {
    try {
      await sequelize.query(`ALTER TABLE ${quoteIdentifier(table)} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (err) {
      console.warn(`ensure table ${table} utf8mb4 failed`, err && err.message ? err.message : err);
    }
  }
}

async function init() {
  await sequelize.authenticate();
  await User.sync();
  await Kitchen.sync();
  await Dish.sync();
  await Order.sync();
  await ensureRequiredColumns();
  await ensureUtf8mb4();
}

module.exports = {
  sequelize,
  init,
  User,
  Kitchen,
  Order,
  Dish
};
