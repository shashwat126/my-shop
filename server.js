const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const Razorpay = require('razorpay');
const path = require('path');
const dns = require('dns');

// DNS Fallback
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {}

const app = express();

// --- Schemas & Models ---
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

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: String,
  password: { type: String, required: true },
  role: { type: String, default: 'customer' },
  createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
const User = mongoose.models.User || mongoose.model('User', userSchema);

// --- Razorpay Setup ---
const RAZORPAY_KEY_ID = 'rzp_test_Ts2knAxziQgjbX';
const RAZORPAY_KEY_SECRET = '7iymKx0j9z6CZBRTORwiFrWM';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// --- Middlewares ---
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

// Global Session Variables for Views
app.use((req, res, next) => {
  const currentCart = req.session.cart || { items: [], totalQty: 0, totalPrice: 0 };
  res.locals.cart = currentCart;
  res.locals.cartCount = currentCart.totalQty || 0;
  res.locals.currentUser = req.session.user || (req.session.isAdmin ? { name: 'Admin', role: 'admin' } : null);
  res.locals.isAdmin = req.session.user?.role === 'admin' || req.session.isAdmin || false;
  next();
});

// --- MongoDB Atlas Connection ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://shashwat126:ShopStore12345@cluster0.f995iqs.mongodb.net/myshop?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  family: 4
})
  .then(() => console.log('✅ MongoDB connected successfully!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Auth Protection Middleware ---
const requireLogin = (req, res, next) => {
  if (req.session.user || req.session.isAdmin) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
  if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
  res.redirect('/login');
};

// ================= ROUTES ================= //

// 1. Home Page (Public)
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

// 2. Product Detail Page (PUBLIC - Har koi dekh sakta hai)
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

// ================= AUTH & OTP ROUTES ================= //

// 1. Signup Form Page
app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

// Step 1: User details collect karke OTP generate karein
app.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      return res.render('signup', { error: 'Sabhi fields bharna zaroori hai!' });
    }

    const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (existingUser) {
      return res.render('signup', { error: 'Yeh Email pehle se registered hai! Login karein.' });
    }

    // 4-Digit Random OTP Generate karein
    const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Session mein store karein
    req.session.pendingSignup = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone ? phone.trim() : '',
      password: password,
      otp: generatedOtp
    };

    // Terminal me clearly display karein
    console.log(`\n==============================================`);
    console.log(`🔑 APNA STORE SIGNUP OTP: [ ${generatedOtp} ]`);
    console.log(`📩 Sent to: ${email}`);
    console.log(`==============================================\n`);

    // OTP verification page par redirect karein
    res.redirect('/verify-otp');

  } catch (err) {
    res.render('signup', { error: 'Signup error: ' + err.message });
  }
});

// Step 2: OTP Page View
app.get('/verify-otp', (req, res) => {
  if (!req.session.pendingSignup) {
    return res.redirect('/signup');
  }
  res.render('verify-otp', { 
    email: req.session.pendingSignup.email,
    error: null 
  });
});

// Step 3: OTP Check & Database Save
app.post('/verify-otp', async (req, res) => {
  try {
    const { otp } = req.body;
    const pending = req.session.pendingSignup;

    if (!pending) {
      return res.redirect('/signup');
    }

    if (!otp || otp.trim() !== pending.otp) {
      return res.render('verify-otp', {
        email: pending.email,
        error: 'Galat OTP! Kripya terminal mein dekhkar sahi 4-digit OTP daalein.'
      });
    }

    // OTP Sahi hai -> Database mein Customer banayein
    const newUser = await User.create({
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      password: pending.password,
      role: 'customer'
    });

    // Session Login
    req.session.user = { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role };
    req.session.pendingSignup = null; // Clean temp session

    const redirectUrl = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(redirectUrl);

  } catch (err) {
    res.render('verify-otp', {
      email: req.session.pendingSignup ? req.session.pendingSignup.email : '',
      error: 'Verification error: ' + err.message
    });
  }
});

// Login Page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email === 'test@gmail.com' && password === '123456') {
      req.session.isAdmin = true;
      req.session.user = { name: 'Admin', email: email, role: 'admin' };
      const redirectUrl = req.session.returnTo || '/';
      delete req.session.returnTo;
      return res.redirect(redirectUrl);
    }

    const user = await User.findOne({ 
      email: email.trim().toLowerCase(), 
      password: password 
    });

    if (user) {
      req.session.user = { id: user._id, name: user.name, email: user.email, role: user.role };
      req.session.isAdmin = user.role === 'admin';
      const redirectUrl = req.session.returnTo || '/';
      delete req.session.returnTo;
      return res.redirect(redirectUrl);
    }

    res.render('login', { error: 'Galat Email ya Password!' });
  } catch (err) {
    res.render('login', { error: 'Login me dikkat aayi!' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Direct Robust Signup (Bina OTP issue ke seedha account create & auto login)
app.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      return res.render('signup', { error: 'Sabhi fields bharna zaroori hai!' });
    }

    const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (existingUser) {
      return res.render('signup', { error: 'Yeh Email pehle se registered hai! Kripya Login karein.' });
    }

    const newUser = await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone ? phone.trim() : '',
      password: password,
      role: 'customer'
    });

    // Auto login session create karein
    req.session.user = { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role };

    const redirectUrl = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('Signup Error:', err);
    res.render('signup', { error: 'Signup me error: ' + err.message });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Admin login check
    if (email === 'test@gmail.com' && password === '123456') {
      req.session.isAdmin = true;
      req.session.user = { name: 'Admin', email: email, role: 'admin' };
      const redirectUrl = req.session.returnTo || '/';
      delete req.session.returnTo;
      return res.redirect(redirectUrl);
    }

    // 2. Customer login check
    const user = await User.findOne({ 
      email: email.trim().toLowerCase(), 
      password: password 
    });

    if (user) {
      req.session.user = { id: user._id, name: user.name, email: user.email, role: user.role };
      req.session.isAdmin = user.role === 'admin';
      const redirectUrl = req.session.returnTo || '/';
      delete req.session.returnTo;
      return res.redirect(redirectUrl);
    }

    res.render('login', { error: 'Galat Email ya Password!' });
  } catch (err) {
    res.render('login', { error: 'Login me dikkat aayi!' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/admin/login', (req, res) => res.redirect('/login'));
app.post('/admin/login', (req, res) => res.redirect(307, '/login'));
app.get('/admin/logout', (req, res) => res.redirect('/logout'));

// 4. Cart Operations (LOCKED: Sirf Login users ke liye)
app.post('/cart/add', requireLogin, async (req, res) => {
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

// 5. Checkout & Razorpay (LOCKED: Sirf Login users ke liye)
app.get('/checkout', requireLogin, (req, res) => {
  const cart = req.session.cart;
  if (!cart || cart.items.length === 0) return res.redirect('/cart');
  res.render('checkout', { cart });
});

app.post('/create-razorpay-order', requireLogin, async (req, res) => {
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
      keyId: RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Razorpay Order Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/verify-payment', requireLogin, async (req, res) => {
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
      paymentMethod: 'Online (Razorpay Test)',
      paymentStatus: 'Paid',
      razorpayOrderId,
      razorpayPaymentId
    });

    req.session.cart = null;
    res.json({ success: true });
  } catch (err) {
    console.error('Verify Payment Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/order-success', (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; margin-top: 80px;">
      <h1 style="color: #16a34a; font-size: 38px;">🎉 Payment Successful & Order Placed!</h1>
      <p style="font-size: 18px; color: #4b5563;">Aapka order register ho chuka hai.</p>
      <a href="/" style="display: inline-block; margin-top: 25px; background: #2563eb; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: bold;">Continue Shopping</a>
    </div>
  `);
});

// 6. Admin Routes
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

app.post('/admin/delete-product/:id', checkAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.redirect('/');
  } catch (err) {
    res.redirect('/');
  }
});

app.get('/admin/orders', checkAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.render('orders', { orders });
  } catch (err) {
    res.redirect('/');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server live hai: http://localhost:${PORT}`);
});