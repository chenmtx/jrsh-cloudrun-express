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
  logging: false,
  define: {
    freezeTableName: true
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

async function init() {
  await sequelize.authenticate();
  await User.sync({ alter: true });
  await Kitchen.sync({ alter: true });
  await Order.sync({ alter: true });
}

module.exports = {
  sequelize,
  init,
  User,
  Kitchen,
  Order
};
