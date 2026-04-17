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
      "http://localhost:5173",
      //"https://your-site-name.netlify.app" // Add this AFTER you get your Netlify link
    ],
    credentials: true,
  }),
);

const port = process.env.PORT || 1069;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.tfpkery.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let complaintsCollection;
let usersCollection;
let ordersCollection;
let workersCollection;

const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWORD;
const is_live = false;
const puppeteer = require("puppeteer");

async function run() {
  try {
    await client.connect();

    const database = client.db("civicEyeDB");
    complaintsCollection = database.collection("complaints");
    usersCollection = database.collection("users");
    ordersCollection = database.collection("orders");
    workersCollection = database.collection("workers");

    // --- ADD THE INDEXES HERE ---
    await complaintsCollection.createIndex(
      { location: "2d" },
      { sparse: true },
    );
    await complaintsCollection.createIndex({
      address: "text",
      description: "text",
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB and created Indexes!");
  } catch (error) {
    console.error("Database connection error:", error);
  }
}
run().catch(console.dir);

const calculateUrgency = (prob) => {
  const now = new Date();
  const cat = (prob.category || "").toLowerCase();
  const desc = (prob.description || "").toLowerCase();

  let keywordWeight = 10;
  // Use the specific weights defined in your Module 2 requirements
  if (cat === "fire hazard") keywordWeight = 40;
  else if (cat === "electrical") keywordWeight = 35;
  else if (cat === "water leak" || cat === "water") keywordWeight = 25;
  else if (cat.includes("garbage") || cat === "environment") keywordWeight = 15;
  else if (cat === "road" || cat.includes("pothole")) keywordWeight = 15;
  else {
    // Fallback to keyword description check
    if (desc.includes("fire") || desc.includes("smoke")) keywordWeight = 40;
    else if (desc.includes("electric") || desc.includes("spark"))
      keywordWeight = 35;
    else if (desc.includes("flood") || desc.includes("leak"))
      keywordWeight = 25;
    else if (desc.includes("trash") || desc.includes("waste"))
      keywordWeight = 15;
  }

  const upvotes = prob.upvotes || 0;
  const createdAtDate = prob.createdAt ? new Date(prob.createdAt) : now;
  const hoursSincePosted = Math.max(
    0,
    (now - createdAtDate) / (1000 * 60 * 60),
  );
  const cappedHours = Math.min(hoursSincePosted, 48);

  // Requirement: (Keyword_Weight * 2) + (Upvote_Count * 1.5) + (Hours_Since_Posted * 0.5)
  const rawScore = keywordWeight * 2 + upvotes * 1.5 + cappedHours * 0.5;
  return Math.min(100, Math.max(1, Math.round(rawScore)));
};

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

// 1. Submit Complaint Endpoint (Zobaer's Module: Duplicate Detection & Auto-Categorization) [cite: 26, 67]
app.post("/api/complaints", async (req, res) => {
  try {
    const complaintData = req.body;
    const { userEmail, location, address, category } = complaintData;

    // Standardize input: Map Report uses 'description', Smart Form uses 'additionalNotes' [cite: 18, 22]
    const userNotes =
      complaintData.description || complaintData.additionalNotes || "";
    const desc = userNotes.toLowerCase();

    if (!userEmail) {
      return res
        .status(400)
        .send({ success: false, error: "User Email is required" });
    }

    // --- TRUST SCORE CHECK (Shah Ahafik Arman's Module) [cite: 23, 25] ---
    const dbUser = await usersCollection.findOne({ email: userEmail });
    if (dbUser && dbUser.trustScore < 30) {
      return res.status(403).send({
        success: false,
        error:
          "Access Denied: Your Trust Score is below 30. You are restricted from submitting new reports.",
      });
    }

    // --- AUTO-CATEGORIZATION & URGENCY WEIGHT (Zobaer Mahmud Zisan's Module) [cite: 20, 42, 67, 68] ---
    let finalCategory = category || "General";
    let keywordWeight = 10; // Default weight

    // Logic to determine category and urgency weight from keywords
    if (
      finalCategory.toLowerCase() === "general" ||
      finalCategory === "General"
    ) {
      if (
        desc.includes("fire") ||
        desc.includes("smoke") ||
        desc.includes("burn")
      ) {
        finalCategory = "Fire Hazard";
        keywordWeight = 40;
      } else if (
        desc.includes("electric") ||
        desc.includes("wire") ||
        desc.includes("spark")
      ) {
        finalCategory = "Electrical";
        keywordWeight = 35;
      } else if (
        desc.includes("flood") ||
        desc.includes("water") ||
        desc.includes("leak") ||
        desc.includes("pipe")
      ) {
        finalCategory = "Water Leak";
        keywordWeight = 25;
      } else if (
        desc.includes("garbage") ||
        desc.includes("trash") ||
        desc.includes("waste")
      ) {
        finalCategory = "Environment";
        keywordWeight = 15;
      } else if (
        desc.includes("pothole") ||
        desc.includes("road") ||
        desc.includes("broken")
      ) {
        finalCategory = "Road/Infrastructure";
        keywordWeight = 15;
      }
    } else {
      // Assign weight even if category was manually selected
      const cat = finalCategory.toLowerCase();
      if (cat.includes("fire") || cat.includes("electrical"))
        keywordWeight = 40;
      else if (cat.includes("water") || cat.includes("leak"))
        keywordWeight = 25;
      else if (cat.includes("environment") || cat.includes("road"))
        keywordWeight = 15;
    }

    // --- SEVERITY CALCULATION (Initial)  ---
    // At creation: Upvotes = 0, Hours_Since_Posted = 0
    // Formula: (Keyword_Weight * 2) + (Upvotes * 1.5) + (Hours * 0.5)
    let initialUrgencyScore = Math.min(
      100,
      Math.max(1, Math.round(keywordWeight * 2)),
    );

    // --- GEOSPATIAL DUPLICATE CHECK (Zobaer Mahmud Zisan's Module) [cite: 26, 28] ---
    let duplicate = null;
    if (location && location.lat) {
      duplicate = await complaintsCollection.findOne({
        category: finalCategory,
        "location.lat": {
          $gte: location.lat - 0.0001,
          $lte: location.lat + 0.0001,
        },
        "location.lng": {
          $gte: location.lng - 0.0001,
          $lte: location.lng + 0.0001,
        },
        status: { $nin: ["Resolved", "Closed"] },
      });
    } else if (address) {
      const addressKey = address.split(",")[0].trim();
      duplicate = await complaintsCollection.findOne({
        category: finalCategory,
        address: { $regex: addressKey, $options: "i" },
        status: { $nin: ["Resolved", "Closed"] },
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

    // --- DATABASE INSERTION ---
    const result = await complaintsCollection.insertOne({
      ...complaintData,
      description: userNotes,
      category: finalCategory,
      status: "Open", // Default starting state [cite: 32]
      urgencyScore: initialUrgencyScore, // Pre-calculated severity
      beforeImage: complaintData.beforeImage || null,
      afterImage: null,
      upvotes: 0,
      flags: 0,
      priority: initialUrgencyScore > 50 ? "High" : "Medium",
      timeline: [
        {
          status: "Reported",
          time: new Date(),
          message: "Issue reported by citizen and logged into the system.",
        },
      ],
      upvotedBy: [],
      flaggedBy: [],
      createdAt: new Date(),
    });

    // --- REWARD TRUST SCORE (Shah Ahafik Arman's Module) [cite: 63] ---
    const updateResult = await usersCollection.updateOne(
      { email: userEmail },
      { $inc: { trustScore: 5 } },
    );

    if (updateResult.matchedCount === 0) {
      await usersCollection.insertOne({
        email: userEmail,
        trustScore: 105, // Start with base 100 + 5 reward [cite: 24, 63]
        name: complaintData.userName || "Citizen",
        createdAt: new Date(),
      });
    }

    res.status(201).send({
      success: true,
      insertedId: result.insertedId,
      message: `Reported as ${finalCategory}! Initial Urgency: ${initialUrgencyScore}`,
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

// 6. Get Single Complaint by ID (For Details Page)
// Example single complaint route
app.get("/api/complaints/:id", async (req, res) => {
  try {
    const prob = await complaintsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!prob) return res.status(404).send({ message: "Not found" });

    // Use the same function to get the consistent score
    res.send({
      ...prob,
      urgencyScore: calculateUrgency(prob),
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
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

    if (complaint.upvotedBy?.includes(userEmail)) {
      return res
        .status(400)
        .send({ success: false, message: "Already upvoted!" });
    }

    const wasFlagged = complaint.flaggedBy?.includes(userEmail);
    const flagDecrement = wasFlagged ? -1 : 0;

    const newUpvoteCount = (complaint.upvotes || 0) + 1;
    const newFlagCount = (complaint.flags || 0) + flagDecrement;

    let newPriority = "Medium";
    if (newUpvoteCount > 10) newPriority = "High";
    if (newFlagCount > 5) newPriority = "Low";

    await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $inc: { upvotes: 1, flags: flagDecrement },
        $set: { priority: newPriority },
        $addToSet: { upvotedBy: userEmail },
        $pull: { flaggedBy: userEmail },
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

    const reportCount = await complaintsCollection.countDocuments({
      userEmail: email,
    });

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

    if (complaint.flaggedBy?.includes(userEmail)) {
      return res
        .status(400)
        .send({ success: false, message: "Already flagged!" });
    }

    const wasUpvoted = complaint.upvotedBy?.includes(userEmail);
    const upvoteDecrement = wasUpvoted ? -1 : 0;

    const newFlagCount = (complaint.flags || 0) + 1;
    const newUpvoteCount = (complaint.upvotes || 0) + upvoteDecrement;

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
  const current_tran_id = new ObjectId().toString();

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
    shipping_method: "No",
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
    let GatewayPageURL = apiResponse.GatewayPageURL;
    res.send({ url: GatewayPageURL });
    console.log("Redirecting user to:", GatewayPageURL);
  });
});

app.post("/payment/success/:tranId", async (req, res) => {
  try {
    const { tranId } = req.params;
    const paymentData = req.body;

    const orderRecord = await ordersCollection.findOne({ tran_id: tranId });

    if (!orderRecord) {
      console.error("❌ No matching order found for TranID:", tranId);
      return res.redirect("http://localhost:5173/profile?status=error");
    }

    if (paymentData.status === "VALID") {
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

app.post("/payment/fail", async (req, res) => {
  const paymentData = req.body;
  console.log("❌ Payment Failed. Reason:", paymentData.error);

  if (paymentData.tran_id) {
    await ordersCollection.updateOne(
      { tran_id: paymentData.tran_id },
      { $set: { status: "failed", error: paymentData.error } },
    );
  }
  res.redirect("http://localhost:5173/profile?status=failed");
});

app.post("/payment/cancel", async (req, res) => {
  console.log("⚠️ Payment Cancelled by user");
  res.redirect("http://localhost:5173/profile?status=cancelled");
});

const CATEGORY_WEIGHTS = {
  "Fire Hazard": 40,
  Electrical: 35,
  "Water Leak": 25,
  Environment: 15,
  "Broken Bench": 5,
  General: 10,
};

// 6. Get All Complaints & Dynamically Calculate Urgency (Module 2)
app.get("/api/complaints", async (req, res) => {
  try {
    const complaints = await complaintsCollection.find().toArray();
    const complaintsWithUrgency = complaints.map((prob) => ({
      ...prob,
      urgencyScore: calculateUrgency(prob),
    }));
    res.send(complaintsWithUrgency);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

const ADMIN_EMAILS = [
  "ak01739394811@gmail.com",
  "jannatul.ferdous17@g.bracu.ac.bd",
];

app.patch("/api/complaints/update-images/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body; // { beforeImage: "url" } or { afterImage: "url" }

    const result = await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates },
    );

    if (result.modifiedCount > 0) {
      res.send({ success: true, message: "Image updated in DB" });
    } else {
      res
        .status(400)
        .send({ success: false, message: "No changes made to DB" });
    }
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// --- WORKER IMAGE UPLOAD ROUTE ---
app.patch("/api/complaints/update-status/:id", async (req, res) => {
  const taskId = req.params.id;
  const { newStatus, workerEmail, message } = req.body;

  // 1. Move the status and add to timeline
  const statusUpdate = await complaintsCollection.updateOne(
    { _id: new ObjectId(taskId) },
    {
      $set: { status: newStatus },
      $push: {
        timeline: { status: newStatus, time: new Date(), message: message },
      },
    },
  );

  // 2. If the task is finished, free the worker
  if (newStatus === "Resolved" && workerEmail) {
    await workersCollection.updateOne(
      { email: workerEmail, assignedTaskIds: new ObjectId(taskId) },
      {
        $inc: { activeJobs: -1 },
        $pull: { assignedTaskIds: new ObjectId(taskId) },
      },
    );
  }

  res.send({ success: true });
});

// 1. UPDATE STATUS (Admin Only) - Legacy route (Keep if used elsewhere, but ideally use /status/:id below)
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
  const adminEmail = req.query.email;

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

    if (!ADMIN_EMAILS.includes(adminEmail)) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const count = parseInt(newCount);
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

    if (!ADMIN_EMAILS.includes(adminEmail)) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const count = parseInt(newCount);
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
    const complaint = await complaintsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (complaint.status === "Fake") {
      return res.send({ success: false, message: "Already marked as fake" });
    }

    await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Fake", priority: "Low" } },
    );

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

// --- 6. STRICT UPDATE STATUS & RESTORE PENALTY ---
app.patch("/api/complaints/status/:id", async (req, res) => {
  const { id } = req.params;
  const { status: newStatus, reporterEmail, adminEmail } = req.body;

  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).send({ message: "Unauthorized" });
  }

  try {
    const oldComplaint = await complaintsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!oldComplaint) {
      return res
        .status(404)
        .send({ success: false, message: "Complaint not found" });
    }

    // Server-Side Strict Workflow Validation [cite: 32, 33]
    const LIFECYCLE = [
      "Open",
      "In Review",
      "Work in Progress",
      "Resolved",
      "Closed",
    ];

    let currentStatus =
      oldComplaint.status === "pending"
        ? "Open"
        : oldComplaint.status || "Open";

    if (newStatus !== "Fake" && currentStatus !== "Fake") {
      const currentIndex = LIFECYCLE.indexOf(currentStatus);
      const newIndex = LIFECYCLE.indexOf(newStatus);

      if (newIndex !== currentIndex + 1 && newIndex !== currentIndex) {
        return res.status(400).send({
          success: false,
          message:
            "Invalid status transition. You must follow the exact lifecycle sequence.",
        });
      }
    }

    // --- TIMELINE LOGIC START ---
    // Use "Reported" for UI clarity if the status is "Open"
    const displayStatus = newStatus === "Open" ? "Reported" : newStatus;

    const timelineEntry = {
      status: displayStatus,
      time: new Date(), // Captured at the moment of update
      message: `Status updated by admin (${adminEmail})`,
    };
    // --- TIMELINE LOGIC END ---

    // RESTORE LOGIC: If moving AWAY from Fake, restore Trust Score [cite: 24, 40]
    if (currentStatus === "Fake" && newStatus !== "Fake") {
      const user = await usersCollection.findOne({ email: reporterEmail });
      if (user) {
        const restoredScore = Math.min(100, (user.trustScore || 0) + 50);
        await usersCollection.updateOne(
          { email: reporterEmail },
          { $set: { trustScore: restoredScore } },
        );
      }
    }

    // Update the complaint status AND push to the timeline array [cite: 31, 49]
    const result = await complaintsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { status: newStatus },
        $push: { timeline: timelineEntry },
      },
    );

    res.send({
      success: true,
      message: `Status updated to ${newStatus}. Timeline entry created.`,
      result,
    });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// --- WORKER COLLECTION & API ---

// POST: Register a new worker application
app.post("/api/workers/apply", async (req, res) => {
  try {
    const workerData = req.body;
    const { email, region, specialization } = workerData;

    // Check if worker already exists
    const existingWorker = await workersCollection.findOne({ email });
    if (existingWorker) {
      return res.status(400).send({
        success: false,
        message: "An application with this email already exists.",
      });
    }

    const newWorker = {
      ...workerData,
      status: "Pending", // Admin must approve
      activeJobs: 0, // Initial load is zero
      assignedTaskIds: [], // Empty task list
      appliedAt: new Date(),
    };

    const result = await workersCollection.insertOne(newWorker);
    res.status(201).send({
      success: true,
      insertedId: result.insertedId,
      message: "Application submitted! Wait for Admin approval.",
    });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// GET: Fetch all verified workers for assignment
app.get("/api/workers/verified", async (req, res) => {
  try {
    const workers = await workersCollection
      .find({ status: "Verified" })
      .toArray();
    res.send(workers);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Change this in your backend index.js
app.get("/api/workers", async (req, res) => {
  try {
    // This fetches EVERYONE regardless of status
    const workers = await workersCollection
      .aggregate([
        {
          $lookup: {
            from: "complaints",
            localField: "assignedTaskIds",
            foreignField: "_id",
            as: "currentTasks",
          },
        },
      ])
      .toArray();
    res.send(workers);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// PATCH: Assign a complaint to a worker
app.patch("/api/workers/assign", async (req, res) => {
  try {
    const { taskId, workerEmail, workerRegion } = req.body;

    const task = await complaintsCollection.findOne({
      _id: new ObjectId(taskId),
    });

    // --- UPDATED VALIDATION LOGIC ---
    // If task.region exists, then we check for a match.
    // If task.region is missing (undefined/null), we skip the mismatch error.
    if (task.region && workerRegion) {
      // Use fuzzy matching (.includes) to handle "Dhaka" vs "Dhaka Division"
      const isMatch =
        task.region.includes(workerRegion) ||
        workerRegion.includes(task.region);

      if (!isMatch) {
        return res.status(400).send({
          success: false,
          message: `Region Mismatch! Task is in ${task.region}, but worker is in ${workerRegion}.`,
        });
      }
    }

    // 3. Update Complaint Status
    await complaintsCollection.updateOne(
      { _id: new ObjectId(taskId) },
      {
        $set: {
          status: "In Review",
          assignedWorkerEmail: workerEmail,
        },
        $push: {
          timeline: {
            status: "In Review",
            message: `Worker ${workerEmail} assigned to this task.`,
            time: new Date(),
          },
        },
      },
    );

    // 4. Update Worker Stats
    await workersCollection.updateOne(
      { email: workerEmail },
      {
        $inc: { activeJobs: 1 },
        $push: { assignedTaskIds: new ObjectId(taskId) },
      },
    );

    res.send({ success: true, message: "Task assigned successfully!" });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// PATCH: Admin approves a worker application
app.patch("/api/workers/verify/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: { status: "Verified" },
    };

    const result = await workersCollection.updateOne(filter, updateDoc);

    if (result.modifiedCount > 0) {
      res.send({ success: true, message: "Worker verified successfully!" });
    } else {
      res.status(404).send({
        success: false,
        message: "Worker not found or already verified.",
      });
    }
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// GET: Check if a specific email belongs to a verified worker
app.get("/api/workers/check/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const worker = await workersCollection.findOne({
      email: email,
      status: "Verified",
    });

    if (worker) {
      res.send({ isWorker: true });
    } else {
      res.send({ isWorker: false });
    }
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// GET: Find which worker is assigned to a specific task
app.get("/api/workers/assigned-to/:taskId", async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const worker = await workersCollection.findOne({
      assignedTaskIds: new ObjectId(taskId),
    });

    if (worker) {
      res.send({
        found: true,
        name: worker.name,
        email: worker.email,
        phone: worker.phone,
      });
    } else {
      res.send({ found: false });
    }
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.patch("/api/complaints/resolve/:id", async (req, res) => {
  try {
    const taskId = req.params.id;
    const { workerEmail } = req.body;

    // 1. Check if the task is already resolved
    const task = await complaintsCollection.findOne({
      _id: new ObjectId(taskId),
    });
    if (task.status === "Resolved") {
      return res
        .status(400)
        .send({ success: false, message: "Task is already resolved." });
    }

    // 2. Update the Complaint
    await complaintsCollection.updateOne(
      { _id: new ObjectId(taskId) },
      {
        $set: { status: "Resolved" },
        $push: {
          timeline: {
            status: "Resolved",
            time: new Date(),
            message: "Work officially completed.",
          },
        },
      },
    );

    // 3. Update the Worker ONLY IF they are currently assigned to this task
    // Using $pull and $inc together ensures we only decrement if the ID was actually there
    const workerUpdate = await workersCollection.updateOne(
      {
        email: workerEmail,
        assignedTaskIds: new ObjectId(taskId), // This is the "Gatekeeper" condition
      },
      {
        $inc: { activeJobs: -1 },
        $pull: { assignedTaskIds: new ObjectId(taskId) },
      },
    );

    res.send({ success: true, message: "Task resolved and worker freed." });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

app.get("/api/admin/generate-report", async (req, res) => {
  try {
    // 1. HELPER FUNCTION (Move this to the TOP of the route)
    const formatDuration = (hours) => {
      if (!hours || hours <= 0) return "0 Mins";
      if (hours < 1) return `${(hours * 60).toFixed(0)} Mins`;
      if (hours > 24) return `${(hours / 24).toFixed(1)} Days`;
      return `${hours.toFixed(1)} Hours`;
    };

    // 2. DATA CALCULATIONS
    const allComplaints = await complaintsCollection.find({}).toArray();
    const resolvedComplaints = allComplaints.filter(
      (c) => c.status === "Resolved" && c.timeline,
    );

    const totalComplaints = allComplaints.length;

    // Top 3 Issues by Upvotes
    const topIssues = [...allComplaints]
      .sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0))
      .slice(0, 3);

    // Resolution Times Logic
    const resolutionStats = resolvedComplaints
      .map((c) => {
        const start = new Date(c.createdAt);
        const endEvent = c.timeline?.find((t) => t.status === "Resolved");
        const end = endEvent ? new Date(endEvent.time) : new Date();

        const diffInMs = end - start;
        const durationHours = diffInMs / (1000 * 60 * 60);

        return {
          category: c.category || "General",
          duration: durationHours > 0 ? durationHours : 0.01,
        };
      })
      .sort((a, b) => a.duration - b.duration);

    const fastest = resolutionStats[0] || { category: "N/A", duration: 0 };
    const slowest = resolutionStats[resolutionStats.length - 1] || {
      category: "N/A",
      duration: 0,
    };

    // 3. HTML TEMPLATE (Now it can find formatDuration)
    const htmlContent = `
      <html>
        <head>
          <style>
            body { font-family: 'Helvetica', sans-serif; padding: 40px; color: #333; }
            .header { text-align: center; border-bottom: 4px solid #3b82f6; padding-bottom: 20px; }
            .stat-card { background: #f3f4f6; padding: 20px; border-radius: 15px; margin: 20px 0; }
            .grid { display: flex; justify-content: space-between; gap: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ddd; }
            th { background-color: #3b82f6; color: white; }
            .highlight { color: #3b82f6; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>CivicEye: Monthly Society Report</h1>
            <p>Generated on: ${new Date().toLocaleDateString()}</p>
          </div>

          <div class="stat-card">
            <h2>Summary</h2>
            <p>Total Complaints Logged: <span class="highlight">${totalComplaints}</span></p>
          </div>

          <h3>Top 3 High-Priority Issues (By Upvotes)</h3>
          <table>
            <tr><th>Issue Category</th><th>Upvotes</th><th>Location</th></tr>
            ${topIssues
              .map(
                (t) => `
              <tr>
                <td>${(t.category || "General").toUpperCase()}</td>
                <td>${t.upvotes || 0}</td>
                <td>${t.region || t.address || "N/A"}</td>
              </tr>`,
              )
              .join("")}
          </table>

          <h3>Efficiency Metrics</h3>
          <div class="grid">
            <div class="stat-card" style="flex: 1; border-left: 5px solid #22c55e;">
              <p><b>Fastest Resolution</b></p>
              <p><span class="highlight">${(fastest.category || "N/A").toUpperCase()}</span></p>
              <p>${formatDuration(fastest.duration)}</p>
            </div>
            <div class="stat-card" style="flex: 1; border-left: 5px solid #ef4444;">
              <p><b>Slowest Resolution</b></p>
              <p><span class="highlight">${(slowest.category || "N/A").toUpperCase()}</span></p>
              <p>${formatDuration(slowest.duration)}</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // 4. GENERATE PDF
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // Good for deployment
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();

    res.contentType("application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=Monthly_Report.pdf");
    res.send(pdfBuffer);
  } catch (error) {
    console.error("PDF Error:", error);
    res.status(500).send({ error: error.message });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const leaderboard = await complaintsCollection
      .aggregate([
        {
          $group: {
            _id: "$userEmail", // Group by user
            userName: { $first: "$userName" },
            totalReports: { $sum: 1 },
            totalUpvotes: { $sum: "$upvotes" },
            validReports: {
              $sum: { $cond: [{ $ne: ["$status", "Rejected"] }, 1, 0] },
            },
          },
        },
        { $sort: { totalUpvotes: -1 } }, // Rank by upvotes or reports
        { $limit: 10 },
      ])
      .toArray();

    // Map the badges based on the logic
    const results = leaderboard.map((user) => ({
      ...user,
      badges: [
        user.totalReports >= 10 ? "Eagle Eye" : null,
        user.totalUpvotes >= 50 ? "Community Guardian" : null,
        user.totalReports >= 5 ? "Active Citizen" : null,
        user.totalUpvotes / user.totalReports > 10 ? "Impact Maker" : null,
      ].filter(Boolean),
    }));

    res.send(results);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get("/api/admin/community-stats", async (req, res) => {
  try {
    const allComplaints = await complaintsCollection.find({}).toArray();

    // 1. Calculate Health Score (Resolved vs Total)
    const total = allComplaints.length;
    const resolved = allComplaints.filter(
      (c) => c.status === "Resolved",
    ).length;
    const healthScore = total > 0 ? Math.round((resolved / total) * 100) : 0;

    // 2. Group by Category for Doughnut Chart
    const categoryData = await complaintsCollection
      .aggregate([
        {
          // 1. Normalize the category to lowercase for grouping
          $project: {
            normalizedCategory: { $toLower: "$category" },
          },
        },
        {
          // 2. Group by the normalized field
          $group: {
            _id: "$normalizedCategory",
            value: { $sum: 1 },
          },
        },
        {
          // 3. Rename _id to name for Recharts and capitalize for the UI
          $project: {
            name: { $toUpper: "$_id" }, // Optional: Makes labels look better (GENERAL)
            value: 1,
            _id: 0,
          },
        },
      ])
      .toArray();

    // Inside your /api/admin/community-stats route
    let statusLabel = "Optimal";
    let statusColor = "text-success"; // Green

    if (healthScore < 50) {
      statusLabel = "Critical";
      statusColor = "text-error"; // Red
    } else if (healthScore < 80) {
      statusLabel = "Stable";
      statusColor = "text-warning"; // Yellow
    }

    res.send({
      healthScore,
      categoryData,
      total,
      resolved,
      statusLabel,
      statusColor,
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
