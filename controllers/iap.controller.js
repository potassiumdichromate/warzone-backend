const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const PlayerProfile = require('../models/PlayerProfile');
const IAPPurchase = require('../models/IAPPurchase');

function loadContractAbi() {
  const candidates = [
    path.resolve(__dirname, '../shared/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../shared/WarzoneInAppPurchase.json'),
    path.resolve(process.cwd(), 'shared/WarzoneInAppPurchase.json'),
    path.resolve(process.cwd(), 'shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../warzonewarrior/src/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../warzone-warriors-frontend/src/abi/WarzoneInAppPurchase.json'),
  ];

  const abiPath = candidates.find((p) => fs.existsSync(p));
  if (!abiPath) {
    throw new Error(
      `WarzoneInAppPurchase ABI not found. Tried: ${candidates.join(', ')}`
    );
  }
  return require(abiPath);
}

const CONTRACT_ABI = loadContractAbi();

const COIN_PACKS = new Map([
  ['100', 100],
  ['500', 500],
  ['1000', 1000],
  ['2000', 2000],
]);
const COIN_PRICES = new Map([
  ['100', '0.5'],
  ['500', '2'],
  ['1000', '4'],
  ['2000', '7.5'],
]);

const GEM_PACKS = new Map([
  ['100', 100],
  ['300', 300],
  ['500', 500],
  ['1000', 1000],
]);
const GEM_PRICES = new Map([
  ['100', '0.5'],
  ['300', '1.5'],
  ['500', '2.5'],
  ['1000', '5'],
]);

const GUN_IDS = new Map([
  ['Shotgun', 4],
  ['Bullpup', 6],
  ['ScarH', 2],
  ['Sniper Rifle', 7],
  ['Tesla Mini', 8],
  ['AWP', 3],
]);
const GUN_PRICES = new Map([
  ['Shotgun', '0.4'],
  ['Bullpup', '0.8'],
  ['ScarH', '1'],
  ['Sniper Rifle', '1.2'],
  ['Tesla Mini', '1.5'],
  ['AWP', '2'],
]);

const DEFAULT_RPC = 'https://api.infra.mainnet.somnia.network';
const RPC_URL = process.env.IAP_RPC_URL || process.env.SOMNIA_RPC_URL || DEFAULT_RPC;
const CONTRACT_ADDRESS_RAW = process.env.IAP_CONTRACT_ADDRESS || '';
const CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase();
const EXPECTED_CHAIN_ID = Number(process.env.IAP_CHAIN_ID || 5031);

const provider =
  CONTRACT_ADDRESS && RPC_URL ? new ethers.providers.JsonRpcProvider(RPC_URL) : null;
const contractInterface = new ethers.utils.Interface(CONTRACT_ABI);
const PURCHASE_TOPIC = contractInterface.getEventTopic('Purchase');

const normalizeAddress = (value) => (value ? value.toLowerCase() : '');

const toPlainMap = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === 'object') return { ...value };
  return {};
};

const ensurePlayerGunMap = (player) => {
  if (player.PlayerGuns instanceof Map) return player.PlayerGuns;
  const map = new Map(Object.entries(player.PlayerGuns || {}));
  player.PlayerGuns = map;
  return map;
};

const resolveProduct = (category, product) => {
  const key = String(product);
  if (category === 'Coins') {
    const amount = COIN_PACKS.get(key);
    if (!amount) {
      const err = new Error('Invalid coin pack');
      err.statusCode = 400;
      throw err;
    }
    const priceEth = COIN_PRICES.get(key);
    if (!priceEth) {
      const err = new Error('Price not configured for coin pack');
      err.statusCode = 500;
      throw err;
    }
    return {
      category,
      product: key,
      amount,
      priceEth,
      price: parseFloat(priceEth),
      priceWei: ethers.utils.parseEther(priceEth),
      currency: 'ETH',
    };
  }

  if (category === 'Gems') {
    const amount = GEM_PACKS.get(key);
    if (!amount) {
      const err = new Error('Invalid gem pack');
      err.statusCode = 400;
      throw err;
    }
    const priceEth = GEM_PRICES.get(key);
    if (!priceEth) {
      const err = new Error('Price not configured for gem pack');
      err.statusCode = 500;
      throw err;
    }
    return {
      category,
      product: key,
      amount,
      priceEth,
      price: parseFloat(priceEth),
      priceWei: ethers.utils.parseEther(priceEth),
      currency: 'ETH',
    };
  }

  if (category === 'Guns') {
    const gunId = GUN_IDS.get(key);
    if (gunId === undefined) {
      const err = new Error('Invalid gun product');
      err.statusCode = 400;
      throw err;
    }
    const priceEth = GUN_PRICES.get(key);
    if (!priceEth) {
      const err = new Error('Price not configured for gun');
      err.statusCode = 500;
      throw err;
    }
    return {
      category,
      product: key,
      amount: null,
      priceEth,
      price: parseFloat(priceEth),
      priceWei: ethers.utils.parseEther(priceEth),
      currency: 'ETH',
      gunId,
    };
  }

  const err = new Error('Unsupported category. Allowed: Coins, Gems, Guns');
  err.statusCode = 400;
  throw err;
};

const buildPurchasePayload = (record) => {
  if (!record) return null;
  return {
    category: record.category,
    product: record.product,
    amount: record.metadata?.amount ?? null,
    gunId: record.metadata?.gunId ?? null,
    priceEth: record.priceEth,
    priceWei: record.priceWei,
    price: record.price,
    currency: 'ETH',
    orderId: record.orderId,
    txHash: record.txHash,
    delivered: record.delivered,
    purchaseId: record._id?.toString?.(),
    chainId: record.chainId ?? null,
    blockNumber: record.metadata?.blockNumber ?? null,
  };
};

// POST /warzone/iap/purchase
exports.purchase = async (req, res) => {
  try {
    const wallet = normalizeAddress(
      req.walletAddress || req.user?.wallet || req.wallet || '',
    );
    if (!wallet) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const { category, product, orderId, txHash } = req.body || {};

    if (!category || !product) {
      return res
        .status(400)
        .json({ ok: false, message: 'category and product are required' });
    }

    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      return res.status(400).json({ ok: false, message: 'orderId is required' });
    }

    if (
      !txHash ||
      typeof txHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())
    ) {
      return res.status(400).json({
        ok: false,
        message: 'txHash must be a 0x-prefixed transaction hash',
      });
    }

    if (!provider || !CONTRACT_ADDRESS) {
      return res.status(500).json({
        ok: false,
        message: 'IAP contract is not configured on the server',
      });
    }

    const categoryNorm = String(category);
    const productNorm = String(product);
    const orderIdTrim = orderId.trim();
    const txHashNorm = txHash.trim().toLowerCase();
    const orderHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(orderIdTrim),
    );

    const player = await PlayerProfile.findOne({
      walletAddress: { $regex: new RegExp(`^${wallet}$`, 'i') },
    });
    if (!player) {
      return res.status(404).json({ ok: false, message: 'Player not found' });
    }

    const existingOrder = await IAPPurchase.findOne({ orderHash });
    if (existingOrder) {
      if (normalizeAddress(existingOrder.walletAddress) !== wallet) {
        return res.status(409).json({
          ok: false,
          message: 'Order already processed by another wallet',
        });
      }
      if (existingOrder.txHash !== txHashNorm) {
        return res.status(409).json({
          ok: false,
          message: 'Order already processed with a different transaction hash',
        });
      }
      if (
        existingOrder.category !== categoryNorm ||
        existingOrder.product !== productNorm
      ) {
        return res
          .status(409)
          .json({ ok: false, message: 'Order already processed for another item' });
      }

      const purchasePayload = buildPurchasePayload(existingOrder);
      return res.json({
        ok: true,
        message: 'Order already processed',
        data: {
          walletAddress: player.walletAddress,
          PlayerResources: player.PlayerResources,
          PlayerGuns: toPlainMap(player.PlayerGuns),
          purchase: purchasePayload,
          priceEth: purchasePayload?.priceEth,
          price: purchasePayload?.price,
          currency: 'ETH',
        },
      });
    }

    const productInfo = resolveProduct(categoryNorm, productNorm);

    const receipt = await provider.getTransactionReceipt(txHashNorm);
    if (!receipt) {
      return res.status(400).json({
        ok: false,
        message: 'Transaction receipt not found (transaction may still be pending)',
      });
    }
    if (receipt.status !== 1) {
      return res
        .status(400)
        .json({ ok: false, message: 'Transaction failed on-chain' });
    }
    if (normalizeAddress(receipt.to) !== CONTRACT_ADDRESS) {
      return res.status(400).json({
        ok: false,
        message: 'Transaction was not sent to the purchase contract',
      });
    }
    if (normalizeAddress(receipt.from) !== wallet) {
      return res.status(400).json({
        ok: false,
        message: 'Transaction sender does not match the authenticated wallet',
      });
    }

    const tx = await provider.getTransaction(txHashNorm);
    if (!tx) {
      return res.status(400).json({ ok: false, message: 'Transaction not found' });
    }
    if (tx.chainId != null && Number(tx.chainId) !== EXPECTED_CHAIN_ID) {
      return res.status(400).json({
        ok: false,
        message: `Transaction was submitted on an unexpected chain (expected ${EXPECTED_CHAIN_ID})`,
      });
    }
    if (!tx.value.eq(productInfo.priceWei)) {
      return res.status(400).json({
        ok: false,
        message: 'Transaction value does not match product price',
      });
    }

    const purchaseLog = receipt.logs.find(
      (log) =>
        normalizeAddress(log.address) === CONTRACT_ADDRESS &&
        log.topics &&
        log.topics[0] === PURCHASE_TOPIC,
    );
    if (!purchaseLog) {
      return res
        .status(400)
        .json({ ok: false, message: 'Purchase event not found in transaction logs' });
    }

    const parsedLog = contractInterface.parseLog(purchaseLog);
    if (normalizeAddress(parsedLog.args.buyer) !== wallet) {
      return res.status(400).json({
        ok: false,
        message: 'Purchase event does not belong to the authenticated wallet',
      });
    }
    if (parsedLog.args.orderId !== orderHash) {
      return res
        .status(400)
        .json({ ok: false, message: 'Order id mismatch in purchase event' });
    }
    if (
      parsedLog.args.category !== categoryNorm ||
      parsedLog.args.product !== productNorm
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Category or product mismatch in purchase event',
      });
    }
    if (!parsedLog.args.priceWei.eq(productInfo.priceWei)) {
      return res.status(400).json({
        ok: false,
        message: 'Purchase event price does not match configured price',
      });
    }

    let message = '';
    let changed = false;
    let delivered = true;

    if (categoryNorm === 'Coins') {
      player.PlayerResources = player.PlayerResources || {
        coin: 0,
        gem: 0,
        stamina: 0,
        medal: 0,
        tournamentTicket: 0,
      };
      const prev = player.PlayerResources.coin ?? 0;
      player.PlayerResources.coin = prev + productInfo.amount;
      message = `Added +${productInfo.amount} coins`;
      changed = true;
    } else if (categoryNorm === 'Gems') {
      player.PlayerResources = player.PlayerResources || {
        coin: 0,
        gem: 0,
        stamina: 0,
        medal: 0,
        tournamentTicket: 0,
      };
      const prev = player.PlayerResources.gem ?? 0;
      player.PlayerResources.gem = prev + productInfo.amount;
      message = `Added +${productInfo.amount} gems`;
      changed = true;
    } else if (categoryNorm === 'Guns') {
      const gunId = productInfo.gunId;
      const gunKey = String(gunId);
      const gunsMap = ensurePlayerGunMap(player);

      const hasGun =
        gunsMap instanceof Map ? gunsMap.get(gunKey) : gunsMap[gunKey];

      if (hasGun) {
        message = `Gun already owned: ${productNorm} (id=${gunId})`;
        delivered = false;
      } else {
        const gunData = {
          id: gunId,
          level: 1,
          ammo: 100000,
          isNew: true,
        };
        if (gunsMap instanceof Map) {
          gunsMap.set(gunKey, gunData);
        } else {
          gunsMap[gunKey] = gunData;
          player.PlayerGuns = gunsMap;
          if (typeof player.markModified === 'function') {
            player.markModified('PlayerGuns');
          }
        }
        message = `Unlocked gun: ${productNorm} (id=${gunId})`;
        changed = true;
      }
    }

    if (changed) {
      await player.save();
    }

    const purchaseRecord = await IAPPurchase.create({
      orderId: orderIdTrim,
      orderHash,
      walletAddress: wallet,
      txHash: txHashNorm,
      category: categoryNorm,
      product: productNorm,
      priceEth: productInfo.priceEth,
      price: productInfo.price,
      priceWei: productInfo.priceWei.toString(),
      delivered,
      chainId: tx.chainId != null ? Number(tx.chainId) : undefined,
      metadata: {
        amount: productInfo.amount ?? null,
        gunId: productInfo.gunId ?? null,
        blockNumber: receipt.blockNumber ?? null,
        transactionIndex: receipt.transactionIndex ?? null,
        logIndex: purchaseLog.logIndex ?? null,
      },
    });

    const purchasePayload = buildPurchasePayload(purchaseRecord);

    return res.json({
      ok: true,
      message,
      data: {
        walletAddress: player.walletAddress,
        PlayerResources: player.PlayerResources,
        PlayerGuns: toPlainMap(player.PlayerGuns),
        purchase: purchasePayload,
        priceEth: purchasePayload.priceEth,
        price: purchasePayload.price,
        currency: 'ETH',
      },
    });
  } catch (err) {
    console.error('IAP purchase error:', err);
    const status = err?.statusCode || 500;
    const message =
      err?.message ||
      'Unable to process purchase at the moment. Please try again later.';
    return res.status(status).json({ ok: false, message });
  }
};
