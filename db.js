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
    type: DataTypes.TEXT,
    allowNull: true
  }
});

const Kitchen = sequelize.define('JrshKitchen', {
  id: {
    type: DataTypes.STRING(128),
    primaryKey: true
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

async function init() {
  await sequelize.authenticate();
  await User.sync({ alter: true });
  await Kitchen.sync({ alter: true });
}

module.exports = {
  init,
  User,
  Kitchen
};
