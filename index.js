const express = require("express");
const cors = require("cors");
require("dotenv").config();
const SSLCommerzPayment = require("sslcommerz-lts");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: [
      "http://localhost:5174",
      //"https://your-site-name.netlify.app" // Add this AFTER you get your Netlify link
    ],
    credentials: true,
  }),
);

const port = process.env.PORT || 1069; // Changed to 1069 as per our previous setup

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.tfpkery.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// --- GLOBAL VARIABLES (Scope Fix) ---
let complaintsCollection;
let usersCollection;
let ordersCollection;

const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWORD;
const is_live = false; //true for live, false for sandbox

async function run() {
  try {
    await client.connect();

    const database = client.db("civicEyeDB");
    complaintsCollection = database.collection("complaints");
    usersCollection = database.collection("users");
    ordersCollection = database.collection("orders");

    // --- ADD THE INDEXES HERE ---
    // This ensures they are created once the database is connected
    await complaintsCollection.createIndex(
      { location: "2d" },
      { sparse: true },
    );
    await complaintsCollection.createIndex({
      address: "text",
      description: "text",
    });

    // const updateOldComplaints = async () => {
    //   const result = await complaintsCollection.updateMany(
    //     { flaggedBy: { $exists: false } }, // Find documents without this array
    //     {
    //       $set: {
    //         flaggedBy: [],
    //         flags: 0,
    //         upvotedBy: [],
    //         priority: "Medium",
    //       },
    //     },
    //   );
    //   if (result.modifiedCount > 0) {
    //     console.log(
    //       `Successfully updated ${result.modifiedCount} old reports with flagging fields.`,
    //     );
    //   }
    // };

    // await updateOldComplaints();

    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB and created Indexes!");
  } catch (error) {
    console.error("Database connection error:", error);
  }
}
run().catch(console.dir);

// --- API ENDPOINTS ---

app.get("/", (req, res) => {
  res.send("CivicEye Server is Running");
});

// 1. Get User Profile & Trust Score
app.get("/api/users/:email", async (req, res) => {
  try {
    const email = req.params.email;
    let user = await usersCollection.findOne({ email });

    if (!user) {
      // Create user on the fly if they don't exist
      const newUser = {
        email,
        trustScore: 100,
        name: "New Citizen",
        createdAt: new Date(),
      };
      await usersCollection.insertOne(newUser);
      user = newUser;
    }
    res.send(user);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// 2. Submit Complaint + Reward Trust Score
app.post("/api/complaints", async (req, res) => {
  try {
    const complaintData = req.body;
    const { userEmail, location, address, category } = complaintData;

    if (!userEmail) {
      return res
        .status(400)
        .send({ success: false, error: "User Email is required" });
    }

    const dbUser = await usersCollection.findOne({ email: userEmail });

    if (dbUser && dbUser.trustScore < 30) {
      return res.status(403).send({
        success: false,
        error:
          "Access Denied: Your Trust Score is below 30. You are restricted from submitting new reports.",
      });
    }

    let duplicate = null;

    if (location && location.lat) {
      duplicate = await complaintsCollection.findOne({
        category: category,
        "location.lat": {
          $gte: location.lat - 0.0001,
          $lte: location.lat + 0.0001,
        },
        "location.lng": {
          $gte: location.lng - 0.0001,
          $lte: location.lng + 0.0001,
        },
        status: { $ne: "resolved" },
      });
    } else if (address) {
      const addressKey = address.split(",")[0].trim();
      duplicate = await complaintsCollection.findOne({
        category: category,
        address: { $regex: addressKey, $options: "i" },
        status: { $ne: "resolved" },
      });
    }

    if (duplicate) {
      return res.status(409).send({
        success: false,
        isDuplicate: true,
        message:
          "This issue has already been reported here. Check the list to upvote it!",
        existingId: duplicate._id,
      });
    }

    const result = await complaintsCollection.insertOne({
      ...complaintData,
      status: "pending",
      upvotes: 0,
      flags: 0,
      priority: "Medium",
      upvotedBy: [],
      flaggedBy: [],
      createdAt: new Date(),
    });

    const updateResult = await usersCollection.updateOne(
      { email: userEmail },
      { $inc: { trustScore: 5 } },
    );

    if (updateResult.matchedCount === 0) {
      await usersCollection.insertOne({
        email: userEmail,
        trustScore: 105,
        name: complaintData.userName || "Citizen",
        createdAt: new Date(),
      });
    }

    res.status(201).send({
      success: true,
      insertedId: result.insertedId,
      message: "Reported! Trust Score increased.",
    });
  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).send({ success: false, error: error.message });
  }
});

// 4. Urgency Logic Feature (Module 2)
app.post("/api/add-complaint-urgent", async (req, res) => {
  try {
    const complaint = req.body;

    // Logic: (Keywords Count * 2) + (Upvotes * 1.5)
    const keywordWeight =
      (Array.isArray(complaint.keywords) ? complaint.keywords.length : 0) * 2;
    const upvoteWeight = (complaint.upvotes || 0) * 1.5;

    complaint.urgencyScore = keywordWeight + upvoteWeight;
    complaint.createdAt = new Date();

    const result = await complaintsCollection.insertOne(complaint);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ error: "Failed to add complaint" });
  }
});

// 5. Sorted Urgent Reports for Admin
app.get("/api/urgent-reports", async (req, res) => {
  try {
    const results = await complaintsCollection
      .find()
      .sort({ urgencyScore: -1 })
      .toArray();
    res.send(results);
  } catch (error) {
    res.status(500).send({ error: "Failed to fetch reports" });
  }
});

// PATCH route to increase upvotes
app.patch("/api/complaints/upvote/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userEmail } = req.body;

    const complaint = await complaintsCollection.findOne({
      _id: new ObjectId(id),
    });
    if (!complaint)
      return res.status(404).send({ success: false, message: "Not found" });

    // 1. Block if already upvoted
    if (complaint.upvotedBy?.includes(userEmail)) {
      return res
        .status(400)
        .send({ success: false, message: "Already upvoted!" });
    }

    // 2. Check if they are switching from a Flag to an Upvote
    const wasFlagged = complaint.flaggedBy?.includes(userEmail);
    const flagDecrement = wasFlagged ? -1 : 0;

    const newUpvoteCount = (complaint.upvotes || 0) + 1;
    const newFlagCount = (complaint.flags || 0) + flagDecrement;

    // 3. Logic: Recalculate Priority based on new counts
    let newPriority = "Medium";
    if (newUpvoteCount > 10) newPriority = "High";
    if (newFlagCount > 5) newPriority = "Low";

    await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $inc: { upvotes: 1, flags: flagDecrement }, // Atomic increment/decrement
        $set: { priority: newPriority },
        $addToSet: { upvotedBy: userEmail }, // Add to upvoters
        $pull: { flaggedBy: userEmail }, // Remove from flaggers
      },
    );

    res.send({
      success: true,
      newPriority,
      flags: newFlagCount,
      upvotes: newUpvoteCount,
    });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// PATCH route to restore trust score
app.patch("/api/users/restore-score/:email", async (req, res) => {
  const { email } = req.params;
  const result = await usersCollection.updateOne(
    { email: email },
    { $set: { trustScore: 80 } },
  );
  res.send({ success: true, message: "Score restored!" });
});
// User-Specific Report Count & Upvotes
app.get("/api/user-stats/:email", async (req, res) => {
  try {
    const { email } = req.params;

    // 1. Count how many reports this email has submitted
    const reportCount = await complaintsCollection.countDocuments({
      userEmail: email,
    });

    // 2. Sum up all upvotes from all reports submitted by this email
    const upvoteData = await complaintsCollection
      .aggregate([
        { $match: { userEmail: email } },
        { $group: { _id: null, totalUpvotes: { $sum: "$upvotes" } } },
      ])
      .toArray();

    const totalUpvotes = upvoteData.length > 0 ? upvoteData[0].totalUpvotes : 0;

    res.send({
      reportCount,
      totalUpvotes,
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// PATCH route to flag a complaint
app.patch("/api/complaints/flag/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userEmail } = req.body;

    const complaint = await complaintsCollection.findOne({
      _id: new ObjectId(id),
    });
    if (!complaint)
      return res.status(404).send({ success: false, message: "Not found" });

    // 1. Block if already flagged
    if (complaint.flaggedBy?.includes(userEmail)) {
      return res
        .status(400)
        .send({ success: false, message: "Already flagged!" });
    }

    // 2. Check if they are switching from an Upvote to a Flag
    const wasUpvoted = complaint.upvotedBy?.includes(userEmail);
    const upvoteDecrement = wasUpvoted ? -1 : 0;

    const newFlagCount = (complaint.flags || 0) + 1;
    const newUpvoteCount = (complaint.upvotes || 0) + upvoteDecrement;

    // 3. Logic: Recalculate Priority
    let newPriority = "Medium";
    if (newFlagCount > 5) newPriority = "Low";
    if (newUpvoteCount > 10) newPriority = "High";

    await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $inc: { flags: 1, upvotes: upvoteDecrement },
        $set: { priority: newPriority },
        $addToSet: { flaggedBy: userEmail },
        $pull: { upvotedBy: userEmail },
      },
    );

    res.send({
      success: true,
      newPriority,
      flags: newFlagCount,
      upvotes: newUpvoteCount,
    });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// Payment Integration with SSLCommerz

app.post("/payment", async (req, res) => {
  const order = req.body;
  // console.log(order.userEmail);
  const current_tran_id = new ObjectId().toString(); // Generate a unique transaction ID

  await ordersCollection.insertOne({
    tran_id: current_tran_id,
    userEmail: order.userEmail,
    status: "pending",
    amount: 500,
    createdAt: new Date(),
  });

  const data = {
    total_amount: 500,
    currency: "BDT",
    tran_id: current_tran_id,
    success_url: `http://localhost:1069/payment/success/${current_tran_id}`,
    fail_url: "http://localhost:1069/payment/fail",
    cancel_url: "http://localhost:1069/payment/cancel",
    ipn_url: "http://localhost:1069/ipn",
    shipping_method: "No", // No shipping for a fine
    product_name: "Trust Score Fine",
    product_category: "Service",
    product_profile: "general",
    cus_name: order.userName,
    cus_email: order.userEmail,
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    cus_phone: order.phoneNumber,
  };
  const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
  sslcz.init(data).then((apiResponse) => {
    // Redirect logic: SSLCommerz gives a URL, we send it back to frontend
    let GatewayPageURL = apiResponse.GatewayPageURL;
    res.send({ url: GatewayPageURL });
    console.log("Redirecting user to:", GatewayPageURL);
  });

  console.log("Payment data received:", data);
});
// Success callback route
app.post("/payment/success/:tranId", async (req, res) => {
  try {
    // 1. GET IT FROM THE URL (the :tranId part)
    const { tranId } = req.params;
    const paymentData = req.body;

    // 2. USE 'tranId' TO FIND THE ORDER
    const orderRecord = await ordersCollection.findOne({ tran_id: tranId });

    if (!orderRecord) {
      console.error("❌ No matching order found for TranID:", tranId);
      return res.redirect("http://localhost:5173/profile?status=error");
    }

    if (paymentData.status === "VALID") {
      // 3. USE THE EMAIL FROM THE DATABASE RECORD
      await usersCollection.updateOne(
        { email: orderRecord.userEmail },
        { $set: { trustScore: 80 } },
      );
      await ordersCollection.updateOne(
        { tran_id: tranId },
        { $set: { status: "success", paymentTime: new Date() } },
      );

      console.log(`✅ Score restored for ${orderRecord.userEmail}`);
      res.redirect(`http://localhost:5173/profile?status=success`);
    }
  } catch (error) {
    console.error("🔥 Error:", error);
    res.redirect("http://localhost:5173/profile?status=error");
  }
});
// Failure callback route
app.post("/payment/fail", async (req, res) => {
  const paymentData = req.body;

  console.log("❌ Payment Failed. Reason:", paymentData.error);
  res.redirect("http://localhost:5173/profile?status=failed");
  // Optional: Update the order status in your database if you have the tran_id
  if (paymentData.tran_id) {
    await ordersCollection.updateOne(
      { tran_id: paymentData.tran_id },
      { $set: { status: "failed", error: paymentData.error } },
    );
  }

  // Redirect back to your React Profile with a failure status
  res.redirect("http://localhost:5173/profile?status=failed");
});
// Cancel callback route
app.post("/payment/cancel", async (req, res) => {
  // Triggered if the user closes the window or clicks "Back"
  console.log("⚠️ Payment Cancelled by user");

  res.redirect("http://localhost:5173/profile?status=cancelled");
});

// Admin Dashboard
// 6. Get All Complaints (For Admin Dashboard)
app.get("/api/complaints", async (req, res) => {
  try {
    // .sort({ upvotes: -1 }) puts the most upvoted items first
    const result = await complaintsCollection
      .find()
      .sort({ upvotes: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// List of authorized admin emails
const ADMIN_EMAILS = ["ak01739394811@gmail.com", "your-email@gmail.com"];

// 1. UPDATE STATUS (Admin Only)
app.patch("/api/complaints/:id", async (req, res) => {
  const { id } = req.params;
  const { status, adminEmail } = req.body;

  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res
      .status(403)
      .send({ message: "Unauthorized: Admin access required" });
  }

  const filter = { _id: new ObjectId(id) };
  const updateDoc = { $set: { status: status } };
  const result = await complaintsCollection.updateOne(filter, updateDoc);
  res.send(result);
});

// 2. DELETE COMPLAINT (Admin Only)
app.delete("/api/complaints/:id", async (req, res) => {
  const { id } = req.params;
  const adminEmail = req.query.email; // Passed as a query param

  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).send({ message: "Unauthorized" });
  }

  const result = await complaintsCollection.deleteOne({
    _id: new ObjectId(id),
  });
  res.send(result);
});
// --- 3. ADMIN MANUAL UPVOTE OVERRIDE ---
app.patch("/api/complaints/admin-upvote/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { newCount, adminEmail } = req.body;

    // Security check
    const ADMIN_EMAILS = ["ak01739394811@gmail.com", "your-email@gmail.com"];
    if (!ADMIN_EMAILS.includes(adminEmail)) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const count = parseInt(newCount);

    // CSE Logic: If admin sets upvotes > 10, set priority to High
    // Otherwise, keep it Medium (unless it's already flagged as Low)
    let newPriority = count > 10 ? "High" : "Medium";

    const result = await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { upvotes: count, priority: newPriority } },
    );

    res.send({ success: true, newPriority, result });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// --- 2. ADMIN MANUAL FLAG OVERRIDE ---
app.patch("/api/complaints/admin-flag/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { newCount, adminEmail } = req.body;

    // Security check
    const ADMIN_EMAILS = ["ak01739394811@gmail.com", "your-email@gmail.com"];
    if (!ADMIN_EMAILS.includes(adminEmail)) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const count = parseInt(newCount);

    // CSE Logic: If admin sets flags > 5, set priority to Low
    let newPriority = count > 5 ? "Low" : "Medium";

    const result = await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { flags: count, priority: newPriority } },
    );

    res.send({ success: true, newPriority, result });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// --- MARK AS FAKE (Admin Action) ---
app.patch("/api/complaints/mark-fake/:id", async (req, res) => {
  const { id } = req.params;
  const { reporterEmail } = req.body;

  try {
    // 1. Get the current complaint to check if it's already fake
    const complaint = await complaintsCollection.findOne({
      _id: new ObjectId(id),
    });

    // Prevent double-penalizing if it's already Fake
    if (complaint.status === "Fake") {
      return res.send({ success: false, message: "Already marked as fake" });
    }

    // 2. Mark as Fake
    await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Fake", priority: "Low" } },
    );

    // 3. Penalty Logic
    const user = await usersCollection.findOne({ email: reporterEmail });
    if (user) {
      const newScore = Math.max(0, (user.trustScore || 0) - 50);
      await usersCollection.updateOne(
        { email: reporterEmail },
        { $set: { trustScore: newScore } },
      );
    }

    res.send({ success: true });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// --- 6. UPDATE STATUS & RESTORE PENALTY ---
app.patch("/api/complaints/status/:id", async (req, res) => {
  const { id } = req.params;
  const { status: newStatus, reporterEmail, adminEmail } = req.body;

  // 1. Security Check
  const ADMIN_EMAILS = ["ak01739394811@gmail.com", "your-email@gmail.com"];
  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).send({ message: "Unauthorized" });
  }

  try {
    // 2. Fetch the OLD data first to check if it WAS "Fake"
    const oldComplaint = await complaintsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!oldComplaint) {
      return res
        .status(404)
        .send({ success: false, message: "Complaint not found" });
    }

    // 3. RESTORE LOGIC: If moving AWAY from Fake, give 50 points back
    if (oldComplaint.status === "Fake" && newStatus !== "Fake") {
      const user = await usersCollection.findOne({ email: reporterEmail });
      if (user) {
        // Cap the score at 100
        const restoredScore = (user.trustScore || 0) + 50;
        await usersCollection.updateOne(
          { email: reporterEmail },
          { $set: { trustScore: restoredScore } },
        );
      }
    }

    // 4. Update the actual complaint status
    const result = await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: newStatus } },
    );

    res.send({
      success: true,
      message: `Status updated to ${newStatus}. Score restored if applicable.`,
      result,
    });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
