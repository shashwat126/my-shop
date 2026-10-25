const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const Razorpay = require('razorpay');
const brevo = require('@getbrevo/brevo');
const path = require('path');
const dns = require('dns');

// DNS Fallback
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {}

const app = express();

// --- Brevo HTTP API Configuration ---
const apiInstance = new brevo.TransactionalEmailsApi();
const apiKey = apiInstance.authentications['apiKey'];
apiKey.apiKey = process.env.BREVO_API_KEY; // Koi secret hardcode nahi hai!


// Helper function: Instant HTTP Email Dispatch via Brevo API
async function sendBrevoEmail(toEmail, subject, htmlContent) {
  const sendSmtpEmail = new brevo.SendSmtpEmail();
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = htmlContent;
  sendSmtpEmail.sender = { name: "Apna Store Support", email: SENDER_EMAIL };
  sendSmtpEmail.to = [{ email: toEmail }];

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✉️ Brevo HTTP API Email dispatched successfully to: ${toEmail}`);
  } catch (err) {
    console.error('Brevo API Error:', err.response ? err.response.text : err.message);
  }
}

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

// Global Session Variables
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

// --- Route Protectors ---
const requireLogin = (req, res, next) => {
  if (req.session.user || req.session.isAdmin) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
  if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
  res.redirect('/login');
};

// ================= PUBLIC ROUTES ================= //

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

app.post('/product/:id/review', requireLogin, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const product = await Product.findById(req.params.id);

    if (product) {
      product.reviews.push({
        userName: req.session.user?.name || 'Customer',
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

// ================= AUTHENTICATION & BREVO API OTP ================= //

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email === 'test@gmail.com' && password === '123456') {
      req.session.isAdmin = true;
      req.session.user = { name: 'Admin', email: email, role: 'admin' };
      return res.redirect('/admin/dashboard');
    }

    const user = await User.findOne({ 
      email: email.trim().toLowerCase(), 
      password: password 
    });

    if (user) {
      req.session.user = { id: user._id, name: user.name, email: user.email, role: user.role };
      req.session.isAdmin = user.role === 'admin';
      
      if (user.role === 'admin') return res.redirect('/admin/dashboard');

      const redirectUrl = req.session.returnTo || '/';
      delete req.session.returnTo;
      return res.redirect(redirectUrl);
    }

    res.render('login', { error: 'Galat Email ya Password!' });
  } catch (err) {
    res.render('login', { error: 'Login me dikkat aayi!' });
  }
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

// Form Submit -> Brevo API Send
app.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      return res.render('signup', { error: 'Sabhi required fields bharein!' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      return res.render('signup', { error: 'Yeh Email pehle se registered hai! Login karein.' });
    }

    const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();

    req.session.pendingSignup = {
      name: name.trim(),
      email: cleanEmail,
      phone: phone ? phone.trim() : '',
      password: password,
      otp: generatedOtp
    };

    // Brevo HTTP Call (Async background dispatch)
    sendBrevoEmail(
      cleanEmail,
      'Your Apna Store Verification Code',
      `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
          <h2 style="color: #1e3a8a; text-align: center; margin-bottom: 8px;">🛍️ Apna Store</h2>
          <p style="font-size: 15px; color: #334155;">Hello ${name},</p>
          <p style="font-size: 15px; color: #334155;">Apna Store par account verify karne ke liye OTP code neeche diya gaya hai:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 10px; color: #2563eb; background: #eff6ff; padding: 12px 24px; border-radius: 8px; border: 1px dashed #2563eb; display: inline-block;">
              ${generatedOtp}
            </span>
          </div>
          <p style="font-size: 13px; color: #64748b;">Yeh code agle 10 minutes tak valid hai. Kripya ise kisi ke sath share na karein.</p>
        </div>
      `
    );

    console.log(`\n==============================================`);
    console.log(`🔑 APNA STORE REGISTRATION OTP: [ ${generatedOtp} ]`);
    console.log(`📩 Sent to: ${cleanEmail}`);
    console.log(`==============================================\n`);

    res.redirect('/verify-otp');
  } catch (err) {
    res.render('signup', { error: 'Signup error: ' + err.message });
  }
});

app.get('/verify-otp', (req, res) => {
  if (!req.session.pendingSignup) return res.redirect('/signup');
  res.render('verify-otp', { 
    email: req.session.pendingSignup.email,
    error: null 
  });
});

app.post('/verify-otp', async (req, res) => {
  try {
    const { otp } = req.body;
    const pending = req.session.pendingSignup;

    if (!pending) return res.redirect('/signup');

    if (!otp || otp.trim() !== pending.otp) {
      return res.render('verify-otp', {
        email: pending.email,
        error: 'Galat OTP! Kripya sahi 4-digit code dalein.'
      });
    }

    const newUser = await User.create({
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      password: pending.password,
      role: 'customer'
    });

    req.session.user = { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role };
    req.session.pendingSignup = null;

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

// ================= FORGOT & RESET PASSWORD FLOW ================= //

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null });
});

app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const cleanEmail = email.trim().toLowerCase();

    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      return res.render('forgot-password', { error: 'Yeh email hamare database mein register nahi hai!' });
    }

    const resetOtp = Math.floor(1000 + Math.random() * 9000).toString();

    req.session.resetSession = {
      email: cleanEmail,
      otp: resetOtp
    };

    // Brevo HTTP Email Call
    sendBrevoEmail(
      cleanEmail,
      'Password Reset OTP - Apna Store',
      `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
          <h2 style="color: #1e3a8a; text-align: center;">🛍️ Apna Store</h2>
          <p style="font-size: 15px; color: #334155;">Hello,</p>
          <p style="font-size: 15px; color: #334155;">Apna password reset karne ke liye OTP code neeche diya gaya hai:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 10px; color: #dc2626; background: #fef2f2; padding: 12px 24px; border-radius: 8px; border: 1px dashed #dc2626; display: inline-block;">
              ${resetOtp}
            </span>
          </div>
          <p style="font-size: 13px; color: #64748b;">Yeh code agle 10 minutes tak valid hai.</p>
        </div>
      `
    );

    console.log(`🔑 Backup Reset OTP: [ ${resetOtp} ]`);
    res.redirect('/reset-password');
  } catch (err) {
    res.render('forgot-password', { error: 'Error: ' + err.message });
  }
});

app.get('/reset-password', (req, res) => {
  if (!req.session.resetSession) return res.redirect('/forgot-password');
  res.render('reset-password', {
    email: req.session.resetSession.email,
    error: null
  });
});

app.post('/reset-password', async (req, res) => {
  try {
    const { otp, newPassword, confirmPassword } = req.body;
    const resetSess = req.session.resetSession;

    if (!resetSess) return res.redirect('/forgot-password');

    if (!otp || otp.trim() !== resetSess.otp) {
      return res.render('reset-password', {
        email: resetSess.email,
        error: 'Galat OTP! Kripya sahi 4-digit code dalein.'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.render('reset-password', {
        email: resetSess.email,
        error: 'Passwords match nahi kar rahe hain!'
      });
    }

    await User.findOneAndUpdate(
      { email: resetSess.email },
      { password: newPassword }
    );

    req.session.resetSession = null;
    res.redirect('/login');
  } catch (err) {
    res.render('reset-password', {
      email: resetSess ? resetSess.email : '',
      error: 'Error: ' + err.message
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ================= CART & CHECKOUT ================= //

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

// ================= DEDICATED ADMIN DASHBOARD ================= //

app.get('/admin/dashboard', checkAdmin, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    const orders = await Order.find().sort({ createdAt: -1 });
    const totalRevenue = orders.reduce((acc, curr) => acc + (curr.totalAmount || 0), 0);

    res.render('admin-dashboard', {
      products,
      orders,
      totalRevenue,
      productCount: products.length,
      orderCount: orders.length
    });
  } catch (err) {
    res.redirect('/');
  }
});

app.post('/admin/order/:id/status', checkAdmin, async (req, res) => {
  try {
    const { orderStatus } = req.body;
    await Order.findByIdAndUpdate(req.params.id, { paymentStatus: orderStatus });
    res.redirect('/admin/dashboard');
  } catch (err) {
    res.redirect('/admin/dashboard');
  }
});

app.get('/admin/add-product', checkAdmin, (req, res) => res.render('add-product'));

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

    res.redirect('/admin/dashboard');
  } catch (err) {
    res.redirect('/admin/add-product');
  }
});

app.get('/admin/edit-product/:id', checkAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/admin/dashboard');
    res.render('edit-product', { product });
  } catch (err) {
    res.redirect('/admin/dashboard');
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

    res.redirect('/admin/dashboard');
  } catch (err) {
    res.redirect('/admin/dashboard');
  }
});

app.post('/admin/delete-product/:id', checkAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.redirect('/admin/dashboard');
  } catch (err) {
    res.redirect('/admin/dashboard');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server live: http://localhost:${PORT}`);
});