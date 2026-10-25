const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const Razorpay = require('razorpay');
const path = require('path');
const dns = require('dns');

// DNS issue bypass karne ke liye IPv4 aur Google DNS set karein
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {}

const app = express();

// --- Models ---
let Product, Order;
try {
  Product = require('./models/Product');
  Order = require('./models/Order');
} catch (e) {
  const productSchema = new mongoose.Schema({
    customId: { type: String, unique: true },
    title: { type: String, required: true },
    category: { type: String, default: 'men' },
    price: { type: Number, required: true },
    originalPrice: Number,
    imageUrl: String,
    images: [String],
    sizes: [String],
    description: String,
    avgRating: { type: Number, default: 0 },
    reviews: [{
      userName: String,
      rating: Number,
      comment: String,
      createdAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now }
  });

  const orderSchema = new mongoose.Schema({
    items: [{
      title: String,
      price: Number,
      quantity: Number,
      size: String
    }],
    totalAmount: Number,
    customerName: String,
    phone: String,
    address: String,
    paymentMethod: { type: String, default: 'Online (Razorpay)' },
    paymentStatus: { type: String, default: 'Pending' },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    createdAt: { type: Date, default: Date.now }
  });

  Product = mongoose.models.Product || mongoose.model('Product', productSchema);
  Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
}

// --- Razorpay Setup (Test Keys) ---
const razorpay = new Razorpay({
  key_id: 'rzp_test_1DP5mmOlF5G5ag',
  key_secret: 'dummySecretKey12345678'
});

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'my-shop-secret-key-1234',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global Session Variables for Views (cartCount & currentUser fix)
app.use((req, res, next) => {
  const currentCart = req.session.cart || { items: [], totalQty: 0, totalPrice: 0 };
  res.locals.cart = currentCart;
  res.locals.cartCount = currentCart.totalQty || 0;
  res.locals.isAdmin = req.session.isAdmin || false;
  res.locals.currentUser = req.session.isAdmin ? { name: 'Admin', role: 'admin' } : null;
  next();
});

// --- Database Connection (MongoDB Atlas) ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://shashwat126:ShopStore12345@cluster0.f995iqs.mongodb.net/myshop?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  family: 4
})
  .then(() => console.log('MongoDB connected successfully!'))
  .catch(err => console.error('MongoDB connection error:', err));

// Admin Auth Middleware
const checkAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

// ================= ROUTES ================= //

// 1. Home Page (Search + Category Filter)
app.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    let filter = {};

    if (category && ['men', 'women', 'kids'].includes(category)) {
      filter.category = category;
    }

    if (search && search.trim() !== '') {
      filter.$or = [
        { title: { $regex: search.trim(), $options: 'i' } },
        { customId: { $regex: search.trim(), $options: 'i' } },
        { description: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.render('index', { 
      products, 
      currentCategory: category || 'all',
      searchQuery: search || ''
    });
  } catch (err) {
    res.render('index', { products: [], currentCategory: 'all', searchQuery: '' });
  }
});

// 2. Product Detail Page with Suggestions
app.get('/product/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/');

    const relatedProducts = await Product.find({
      category: product.category,
      _id: { $ne: product._id }
    }).limit(4);

    res.render('product-detail', { product, relatedProducts });
  } catch (err) {
    res.redirect('/');
  }
});

// 3. Customer Review Submission
app.post('/product/:id/review', async (req, res) => {
  try {
    const { userName, rating, comment } = req.body;
    const product = await Product.findById(req.params.id);

    if (product) {
      product.reviews.push({
        userName,
        rating: Number(rating),
        comment
      });

      const sum = product.reviews.reduce((acc, item) => acc + item.rating, 0);
      product.avgRating = sum / product.reviews.length;

      await product.save();
    }
    res.redirect(`/product/${req.params.id}`);
  } catch (err) {
    res.redirect('back');
  }
});

// 4. Cart Operations
app.post('/cart/add', async (req, res) => {
  try {
    const { productId, selectedSize } = req.body;
    const product = await Product.findById(productId);

    if (!product) return res.redirect('/');

    if (!req.session.cart) {
      req.session.cart = { items: [], totalQty: 0, totalPrice: 0 };
    }

    const cart = req.session.cart;
    const itemIndex = cart.items.findIndex(
      i => i.productId.toString() === productId && i.size === (selectedSize || 'Standard')
    );

    const img = (product.images && product.images.length > 0) ? product.images[0] : (product.imageUrl || '');

    if (itemIndex > -1) {
      cart.items[itemIndex].quantity += 1;
    } else {
      cart.items.push({
        productId: product._id,
        title: product.title,
        price: product.price,
        imageUrl: img,
        size: selectedSize || 'Standard',
        quantity: 1
      });
    }

    cart.totalQty += 1;
    cart.totalPrice += product.price;

    res.redirect('/cart');
  } catch (err) {
    res.redirect('/');
  }
});

app.get('/cart', (req, res) => {
  res.render('cart', { cart: req.session.cart || { items: [], totalQty: 0, totalPrice: 0 } });
});

app.post('/cart/remove', (req, res) => {
  const { index } = req.body;
  const cart = req.session.cart;

  if (cart && cart.items[index]) {
    cart.totalQty -= cart.items[index].quantity;
    cart.totalPrice -= (cart.items[index].price * cart.items[index].quantity);
    cart.items.splice(index, 1);
  }

  res.redirect('/cart');
});

// 5. Checkout & Payment Routes
app.get('/checkout', (req, res) => {
  const cart = req.session.cart;
  if (!cart || cart.items.length === 0) return res.redirect('/cart');
  res.render('checkout', { cart });
});

// Razorpay Order Creation API
app.post('/create-razorpay-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const options = {
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `rcpt_${Date.now()}`
    };
    const order = await razorpay.orders.create(options);
    res.json({
      orderId: order.id,
      amount: order.amount,
      keyId: 'rzp_test_1DP5mmOlF5G5ag'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Razorpay Payment Verify & Order Placement
app.post('/verify-payment', async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, customerName, phone, address } = req.body;
    const cart = req.session.cart;

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart khali hai' });
    }

    await Order.create({
      items: cart.items.map(i => ({
        title: i.title,
        price: i.price,
        quantity: i.quantity,
        size: i.size
      })),
      totalAmount: cart.totalPrice,
      customerName,
      phone,
      address,
      paymentMethod: 'Online (Razorpay UPI/Card)',
      paymentStatus: 'Paid',
      razorpayOrderId,
      razorpayPaymentId
    });

    req.session.cart = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Order Success Screen
app.get('/order-success', (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; margin-top: 80px;">
      <h1 style="color: #16a34a; font-size: 38px;">🎉 Payment Successful & Order Placed!</h1>
      <p style="font-size: 18px; color: #4b5563;">Aapka order register ho chuka hai aur confirmation details record ho chuki hain.</p>
      <a href="/" style="display: inline-block; margin-top: 25px; background: #2563eb; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: bold;">Continue Shopping</a>
    </div>
  `);
});

// 6. Admin Authentication & Management
app.get('/admin/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === 'test@gmail.com' && password === '123456') {
    req.session.isAdmin = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Galat Email ya Password!' });
});

app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/');
});

// Add Product
app.get('/admin/add-product', checkAdmin, (req, res) => {
  res.render('add-product');
});

app.post('/admin/add-product', checkAdmin, async (req, res) => {
  try {
    const { customId, title, category, price, originalPrice, images, sizes, description } = req.body;
    
    const imgArray = images ? images.split(',').map(s => s.trim()).filter(Boolean) : [];
    const sizeArray = sizes ? sizes.split(',').map(s => s.trim()).filter(Boolean) : [];

    await Product.create({
      customId: customId || `PROD-${Date.now()}`,
      title,
      category,
      price: Number(price),
      originalPrice: originalPrice ? Number(originalPrice) : null,
      images: imgArray,
      imageUrl: imgArray[0] || '',
      sizes: sizeArray,
      description
    });

    res.redirect('/');
  } catch (err) {
    res.redirect('/admin/add-product');
  }
});

// Edit Product
app.get('/admin/edit-product/:id', checkAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/');
    res.render('edit-product', { product });
  } catch (err) {
    res.redirect('/');
  }
});

app.post('/admin/edit-product/:id', checkAdmin, async (req, res) => {
  try {
    const { customId, title, category, price, originalPrice, images, sizes, description } = req.body;

    const imgArray = images ? images.split(',').map(s => s.trim()).filter(Boolean) : [];
    const sizeArray = sizes ? sizes.split(',').map(s => s.trim()).filter(Boolean) : [];

    await Product.findByIdAndUpdate(req.params.id, {
      customId,
      title,
      category,
      price: Number(price),
      originalPrice: originalPrice ? Number(originalPrice) : null,
      images: imgArray,
      imageUrl: imgArray[0] || '',
      sizes: sizeArray,
      description
    });

    res.redirect('/');
  } catch (err) {
    res.redirect('/');
  }
});

// Delete Product
app.post('/admin/delete-product/:id', checkAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.redirect('/');
  } catch (err) {
    res.redirect('/');
  }
});

// View Orders
app.get('/admin/orders', checkAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.render('orders', { orders });
  } catch (err) {
    res.redirect('/');
  }
});

// --- Server Port Setup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server live hai: http://localhost:${PORT}`);
});