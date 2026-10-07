-- Store appointment confirmation and payment records for clinic visits.
ALTER TABLE appointments
  ADD COLUMN payment_method ENUM('CASH','RAZORPAY') NOT NULL DEFAULT 'CASH' AFTER reason;
ALTER TABLE appointments
  ADD COLUMN payment_status ENUM('CASH_DUE','PENDING','PAID','FAILED','EXPIRED') NOT NULL DEFAULT 'CASH_DUE' AFTER payment_method;
ALTER TABLE appointments ADD COLUMN payment_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER payment_status;
ALTER TABLE appointments ADD COLUMN razorpay_order_id VARCHAR(64) NULL AFTER payment_amount;
ALTER TABLE appointments ADD COLUMN razorpay_payment_id VARCHAR(64) NULL AFTER razorpay_order_id;
ALTER TABLE appointments ADD UNIQUE KEY uq_appointment_razorpay_order (razorpay_order_id);
ALTER TABLE appointments ADD UNIQUE KEY uq_appointment_razorpay_payment (razorpay_payment_id);
