const mongoose = require('mongoose');

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
  paymentMethod: { type: String, default: 'Online / Razorpay' },
  paymentStatus: { type: String, default: 'Pending' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', orderSchema);