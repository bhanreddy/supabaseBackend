export const NotificationEventConfig = Object.freeze({

    // ===== ATTENDANCE =====
    ATTENDANCE_ABSENT: {
        channelId: 'attendance_absent_alert',
        sound: 'attendance_absent_alert.wav',
        titleTemplate: '🚨 Attendance Alert',
        bodyTemplate: '❌ Absent on {{date}}.',
        titleTemplate_te: '🚨 హాజరు హెచ్చరిక',
        bodyTemplate_te: '❌ {{date}} న గైర్హాజరు.',
        deepLink: '/Screen/attendance',
        requiredParams: ['date']
    },
    ATTENDANCE_PRESENT: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '✅ Attendance Update',
        bodyTemplate: '🙋 {{message}}',
        titleTemplate_te: '✅ హాజరు నవీకరణ',
        bodyTemplate_te: '🙋 {{message_te}}',
        deepLink: '/Screen/attendance',
        requiredParams: ['message']
    },

    // ===== DIARY / HOMEWORK =====
    DIARY_UPDATED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📓 Diary Update',
        bodyTemplate: '✏️ {{message}}',
        titleTemplate_te: '📓 డైరీ నవీకరణ',
        bodyTemplate_te: '✏️ {{message_te}}',
        deepLink: '/Screen/diary',
        requiredParams: ['message']
    },

    // ===== RESULTS / EXAM =====
    RESULT_RELEASED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🏆 Results Announced',
        bodyTemplate: '📊 {{message}}',
        titleTemplate_te: '🏆 ఫలితాలు ప్రకటించబడ్డాయి',
        bodyTemplate_te: '📊 {{message_te}}',
        deepLink: '/(tabs)/results',
        requiredParams: ['message']
    },
    EXAM_TIMETABLE_PUBLISHED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📅 Exam Timetable & Syllabus Published',
        bodyTemplate: '📝 {{message}}',
        titleTemplate_te: '📅 పరీక్షల టైమ్‌టేబుల్ & సిలబస్ ప్రచురించబడింది',
        bodyTemplate_te: '📝 {{message_te}}',
        deepLink: '/(tabs)/timetable',
        requiredParams: ['message']
    },

    // ===== COMPLAINTS (General) =====
    COMPLAINT_CREATED: {   // Staff → Parent (student login)
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '⚠️ New Complaint',
        bodyTemplate: '📣 {{message}}',
        titleTemplate_te: '⚠️ కొత్త ఫిర్యాదు',
        bodyTemplate_te: '📣 {{message_te}}',
        deepLink: '/Screen/complaints',
        requiredParams: ['message']
    },
    COMPLAINT_RESPONSE: {  // If admin replies later
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '💬 Complaint Update',
        bodyTemplate: '🔁 {{message}}',
        titleTemplate_te: '💬 ఫిర్యాదు నవీకరణ',
        bodyTemplate_te: '🔁 {{message_te}}',
        deepLink: '/Screen/complaints',
        requiredParams: ['message']
    },

    // ===== LMS (Homework / Assignment) =====
    LMS_CONTENT: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🎓 New Study Material',
        bodyTemplate: '📖 {{message}}',
        titleTemplate_te: '🎓 కొత్త అధ్యయన సామగ్రి',
        bodyTemplate_te: '📖 {{message_te}}',
        deepLink: '/Screen/lms',
        requiredParams: ['message']
    },

    // ===== TIMETABLE (Event / Circular) =====
    TIMETABLE_UPDATED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📅 Timetable Update',
        bodyTemplate: '🕐 {{message}}',
        titleTemplate_te: '📅 టైమ్‌టేబుల్ నవీకరణ',
        bodyTemplate_te: '🕐 {{message_te}}',
        deepLink: '/(tabs)/timetable',
        requiredParams: ['message']
    },

    // ===== NOTICES (Announcement) =====
    NOTICE_ADMIN_STUDENT: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📢 Admin Notice',
        bodyTemplate: '🗞️ {{message}}',
        titleTemplate_te: '📢 అడ్మిన్ నోటీసు',
        bodyTemplate_te: '🗞️ {{message_te}}',
        deepLink: '/Screen/announcements',
        requiredParams: ['message']
    },

    // ===== FEES =====
    FEE_REMINDER: {   // Manual trigger only
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '⏰ Fee Reminder',
        bodyTemplate: '💳 {{message}}',
        titleTemplate_te: '⏰ ఫీజు రిమైండర్',
        bodyTemplate_te: '💳 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    ARREARS_REMINDER: {   // Previous-year defaulter reminder
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '⏰ Arrears Reminder',
        bodyTemplate: '💳 {{message}}',
        titleTemplate_te: '⏰ గత సంవత్సరం బకాయి రిమైండర్',
        bodyTemplate_te: '💳 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FEE_COLLECTED: {   // Payment confirmation — General/Other
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '✅ Fee Received',
        bodyTemplate: '💰 {{message}}',
        titleTemplate_te: '✅ ఫీజు అందుకున్నారు',
        bodyTemplate_te: '💰 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FEE_PAYMENT_DELETION_REQUESTED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '🗑️ Payment Deletion Request',
        bodyTemplate: '🧾 {{message}}',
        titleTemplate_te: '🗑️ చెల్లింపు తొలగింపు అభ్యర్థన',
        bodyTemplate_te: '🧾 {{message}}',
        deepLink: '/admin/fee-approvals',
        requiredParams: ['message']
    },
    FEE_PAYMENT_DELETION_APPROVED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '✅ Payment Deletion Approved',
        bodyTemplate: '🧾 {{message}}',
        titleTemplate_te: '✅ చెల్లింపు తొలగింపు ఆమోదించబడింది',
        bodyTemplate_te: '🧾 {{message}}',
        deepLink: '/accounts/receipts',
        requiredParams: ['message']
    },
    FEE_PAYMENT_DELETION_REJECTED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '❌ Payment Deletion Rejected',
        bodyTemplate: '🧾 {{message}}',
        titleTemplate_te: '❌ చెల్లింపు తొలగింపు తిరస్కరించబడింది',
        bodyTemplate_te: '🧾 {{message}}',
        deepLink: '/accounts/receipts',
        requiredParams: ['message']
    },
    FEE_ADJUSTED: {   // Fee adjustment/waiver applied
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '⚙️ Fee Adjusted',
        bodyTemplate: '💳 {{message}}',
        titleTemplate_te: '⚙️ ఫీజు సర్దుబాటు చేయబడింది',
        bodyTemplate_te: '💳 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_CREATED: {
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '⚠️ New Fine Notice',
        bodyTemplate: '💳 {{message}}',
        titleTemplate_te: '⚠️ కొత్త జరిమానా నోటీసు',
        bodyTemplate_te: '💳 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_INCREASED: {
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '⚠️ Fine Updated',
        bodyTemplate: '💳 {{message}}',
        titleTemplate_te: '⚠️ జరిమానా నవీకరించబడింది',
        bodyTemplate_te: '💳 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_APPROVED: {
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '📋 Fine Assessment Approved',
        bodyTemplate: '💳 {{message}}',
        titleTemplate_te: '📋 జరిమానా ఆమోదించబడింది',
        bodyTemplate_te: '💳 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_WARNING: {
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '⏳ Overdue Fee Warning',
        bodyTemplate: '⚠️ {{message}}',
        titleTemplate_te: '⏳ గడువు ముగిసిన రుసుము హెచ్చరిక',
        bodyTemplate_te: '⚠️ {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_WAIVED: {
        channelId: 'fee_reminder',
        sound: 'fee_reminder.wav',
        titleTemplate: '✨ Fine Waived',
        bodyTemplate: '🎉 {{message}}',
        titleTemplate_te: '✨ జరిమానా మాఫీ చేయబడింది',
        bodyTemplate_te: '🎉 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_CANCELLED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: 'ℹ️ Fine Cancelled',
        bodyTemplate: '📝 {{message}}',
        titleTemplate_te: 'ℹ️ జరిమానా రద్దు చేయబడింది',
        bodyTemplate_te: '📝 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_PAID: {
        channelId: 'fee_reminder',
        sound: 'voice_alert.wav',
        titleTemplate: '✅ Fine Payment Recorded',
        bodyTemplate: '🧾 {{message}}',
        titleTemplate_te: '✅ జరిమానా చెల్లింపు నమోదు చేయబడింది',
        bodyTemplate_te: '🧾 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },
    FINE_DISPUTE_UPDATED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '💬 Fine Review Status',
        bodyTemplate: '🔍 {{message}}',
        titleTemplate_te: '💬 జరిమానా సమీక్ష స్థితి',
        bodyTemplate_te: '🔍 {{message_te}}',
        deepLink: '/Screen/fees',
        requiredParams: ['message']
    },

    // ===== ADMISSION DOCUMENTS =====
    ADMISSION_DOCUMENT_REMINDER: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: 'Admission documents pending',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'ప్రవేశ పత్రాలు పెండింగ్‌లో ఉన్నాయి',
        bodyTemplate_te: '{{message_te}}',
        deepLink: '/Screen/profile',
        requiredParams: ['message']
    },

    // ===== LEAVES (General) =====
    LEAVE_SUBMITTED: {   // Notify admin only
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '📨 Leave Request',
        bodyTemplate: '🏖️ {{message}}',
        titleTemplate_te: '📨 సెలవు అభ్యర్థన',
        bodyTemplate_te: '🏖️ {{message_te}}',
        deepLink: '/admin/leaves',
        requiredParams: ['message']
    },
    LEAVE_APPROVED: {    // Notify applicant only
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '✅ Leave Approved',
        bodyTemplate: '🎉 {{message}}',
        titleTemplate_te: '✅ సెలవు ఆమోదించబడింది',
        bodyTemplate_te: '🎉 {{message_te}}',
        deepLink: '/staff/leaves',
        requiredParams: ['message']
    },
    LEAVE_REJECTED: {    // Notify applicant only
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '❌ Leave Rejected',
        bodyTemplate: '🚫 {{message}}',
        titleTemplate_te: '❌ సెలవు తిరస్కరించబడింది',
        bodyTemplate_te: '🚫 {{message_te}}',
        deepLink: '/staff/leaves',
        requiredParams: ['message']
    },

    // ===== EXPENSES (General) =====
    EXPENSE_CREATED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '📤 Expense Submitted',
        bodyTemplate: '🧾 {{message}}',
        titleTemplate_te: '📤 ఖర్చు సమర్పించబడింది',
        bodyTemplate_te: '🧾 {{message_te}}',
        deepLink: '/admin/expenses',
        requiredParams: ['message']
    },
    EXPENSE_APPROVED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '✅ Expense Approved',
        bodyTemplate: '💹 {{message}}',
        titleTemplate_te: '✅ ఖర్చు ఆమోదించబడింది',
        bodyTemplate_te: '💹 {{message_te}}',
        deepLink: '/accounts/expenses',
        requiredParams: ['message']
    },
    EXPENSE_REJECTED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '❌ Expense Rejected',
        bodyTemplate: '🚫 {{message}}',
        titleTemplate_te: '❌ ఖర్చు తిరస్కరించబడింది',
        bodyTemplate_te: '🚫 {{message_te}}',
        deepLink: '/accounts/expenses',
        requiredParams: ['message']
    },

    // ===== PAYROLL (General) =====
    PAYROLL_SUCCESS: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '💰 Salary Credited',
        bodyTemplate: '🏦 {{message}}',
        titleTemplate_te: '💰 జీతం జమ అయింది',
        bodyTemplate_te: '🏦 {{message_te}}',
        deepLink: '/staff/payslip',
        requiredParams: ['message']
    },

    // ===== ACCESS CONTROL (General) =====
    ACCESS_RESPONSE: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🔐 Access Request Update',
        bodyTemplate: '🔓 {{message}}',
        titleTemplate_te: '🔐 యాక్సెస్ అభ్యర్థన నవీకరణ',
        bodyTemplate_te: '🔓 {{message_te}}',
        deepLink: '/accounts/dashboard',
        requiredParams: ['message']
    },

    // ===== TRANSPORT (General — bus checkpoints) =====
    BUS_STOP_REACHED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🚌 Bus Update',
        titleTemplate_te: '🚌 బస్ అప్‌డేట్',
        bodyTemplate: '📍 Bus has reached {{stopName}}',
        bodyTemplate_te: '📍 బస్ {{stopName}} చేరుకుంది',
        deepLink: '/Screen/busTracker',
        requiredParams: ['stopName']
    },

    BUS_TRIP_COMPLETED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🏁 Trip Completed',
        titleTemplate_te: '🏁 ప్రయాణం పూర్తయింది',
        bodyTemplate: '🚌 Trip on route "{{routeName}}" is complete',
        bodyTemplate_te: '🚌 "{{routeName}}" రూట్‌పై ప్రయాణం పూర్తయింది',
        deepLink: '/Screen/busTracker',
        requiredParams: ['routeName']
    },

    TRANSPORT_TRIP_STARTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🚌 Bus Started',
        titleTemplate_te: '🚌 బస్ ప్రారంభమైంది',
        bodyTemplate: '🚌 Your child\'s school bus has started its journey. Track its progress to {{stopName}} in the app.',
        bodyTemplate_te: '🚌 మీ పిల్లల పాఠశాల బస్ ప్రయాణం ప్రారంభమైంది. {{stopName}} వద్దకు వచ్చే వివరాలను యాప్‌లో చూడండి.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['stopName']
    },

    TRANSPORT_BUS_APPROACHING: {
        // Dedicated channel: Android notification-channel sound is authoritative.
        // The same full filename is used by APNs on iOS.
        channelId: 'bus_confirmation',
        sound: 'busconfirmation.wav',
        titleTemplate: '🚌 Bus Approaching',
        titleTemplate_te: '🚌 బస్ సమీపిస్తోంది',
        bodyTemplate: '🚌 School bus is approaching {{stopName}}. Please check live tracking and be ready.',
        bodyTemplate_te: '🚌 పాఠశాల బస్ {{stopName}} వైపు వస్తోంది. దయచేసి సిద్ధంగా ఉండండి.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['stopName']
    },

    TRANSPORT_BUS_RUNNING_LATE: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🚌 Bus Delay',
        titleTemplate_te: '🚌 బస్ ఆలస్యం',
        bodyTemplate: '🚌 Bus running ~{{delayMinutes}} min late today.',
        bodyTemplate_te: '🚌 ఈ రోజు బస్ సుమారు {{delayMinutes}} నిమిషాలు ఆలస్యంగా నడుస్తోంది.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['delayMinutes']
    },

    TRANSPORT_BUS_DEPARTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🚌 Bus Departed',
        titleTemplate_te: '🚌 బస్ బయలుదేరింది',
        bodyTemplate: '🚌 Bus departed {{stopName}} — {{studentName}} {{boardingStatus}}.',
        bodyTemplate_te: '🚌 బస్ {{stopName}} నుండి బయలుదేరింది — {{studentName}} {{boardingStatus_te}}.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['stopName']
    },

    TRANSPORT_BUS_RUNNING_LATE: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🚌 Bus Delay',
        titleTemplate_te: '🚌 బస్ ఆలస్యం',
        bodyTemplate: '🚌 Bus running ~{{delayMinutes}} min late today.',
        bodyTemplate_te: '🚌 ఈ రోజు బస్ సుమారు {{delayMinutes}} నిమిషాలు ఆలస్యంగా నడుస్తోంది.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['delayMinutes']
    },

    TRANSPORT_BUS_DEPARTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🚌 Bus Departed',
        titleTemplate_te: '🚌 బస్ బయలుదేరింది',
        bodyTemplate: '🚌 Bus departed {{stopName}} — {{studentName}} {{boardingStatus}}.',
        bodyTemplate_te: '🚌 బస్ {{stopName}} నుండి బయలుదేరింది — {{studentName}} {{boardingStatus_te}}.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['stopName', 'studentName', 'boardingStatus', 'boardingStatus_te']
    },

    TRANSPORT_TRIP_CANCELLED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '⚠️ Trip Cancelled',
        titleTemplate_te: '⚠️ ప్రయాణం రద్దు',
        bodyTemplate: '⚠️ Today\'s school bus trip has been cancelled. Please arrange alternative transport for your child.',
        bodyTemplate_te: '⚠️ నేటి పాఠశాల బస్ ప్రయాణం రద్దు చేయబడింది. దయచేసి మీ పిల్లలకు ప్రత్యామ్నాయ రవాణా ఏర్పాటు చేయండి.',
        deepLink: '/Screen/busTracker',
        requiredParams: []
    },

    STUDENT_BUS_PRESENT: {
        // Dedicated channel so Android plays bus_present.wav (the channel's sound
        // is authoritative on Android, not the per-message sound). Filename must
        // be lowercase to match the android raw resource.
        channelId: 'bus_present',
        sound: 'bus_present.wav',
        titleTemplate: '🚌 Bus Boarding Update',
        titleTemplate_te: '🚌 బస్ బోర్డింగ్ అప్‌డేట్',
        bodyTemplate: '✅ {{studentName}} has boarded the bus at {{stopName}}.',
        bodyTemplate_te: '✅ {{studentName}} {{stopName}} వద్ద బస్సు ఎక్కారు.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['studentName', 'stopName']
    },
    STUDENT_BUS_ABSENT: {
        // Reuses the existing absent-alert channel/sound.
        channelId: 'attendance_absent_alert',
        sound: 'attendance_absent_alert.wav',
        titleTemplate: '🚌 Bus Attendance',
        titleTemplate_te: '🚌 బస్ హాజరు',
        bodyTemplate: '❌ {{studentName}} was marked absent for the bus at {{stopName}}.',
        bodyTemplate_te: '❌ {{studentName}} {{stopName}} వద్ద బస్సుకు గైర్హాజరుగా గుర్తించబడ్డారు.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['studentName', 'stopName']
    },

    // ===== MESSENGER =====
    MESSAGE_RECEIVED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '💬 New Message',
        bodyTemplate: '📩 {{message}}',
        titleTemplate_te: '💬 కొత్త సందేశం',
        bodyTemplate_te: '📩 {{message_te}}',
        deepLink: '/Screen/messages',
        requiredParams: ['message']
    },

    // ===== BATCH 2: ATTENDANCE RISK =====
    ATTENDANCE_RISK_WARNING: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '⚠️ Attendance Warning',
        titleTemplate_te: '⚠️ హాజరు హెచ్చరిక',
        bodyTemplate: 'Attendance for {{studentName}} has reached {{attendancePct}}% (threshold: {{threshold}}%). Please monitor regularly.',
        bodyTemplate_te: '{{studentName}} యొక్క హాజరు {{attendancePct}}%కి చేరింది (పరిమితి: {{threshold}}%). దయచేసి క్రమం తప్పకుండా గమనించండి.',
        deepLink: '/Screen/attendance',
        requiredParams: ['studentName', 'attendancePct', 'threshold']
    },
    ATTENDANCE_RISK_CRITICAL: {
        channelId: 'attendance_absent_alert',
        sound: 'attendance_absent_alert.wav',
        titleTemplate: '🚨 Low Attendance Alert',
        titleTemplate_te: '🚨 తక్కువ హాజరు హెచ్చరిక',
        bodyTemplate: 'Attendance for {{studentName}} has fallen to {{attendancePct}}%. The school minimum requirement is {{threshold}}%. Please contact the class teacher.',
        bodyTemplate_te: '{{studentName}} యొక్క హాజరు {{attendancePct}}%కి పడిపోయింది. పాఠశాల కనీస అవసరం {{threshold}}%. దయచేసి తరగతి ఉపాధ్యాయుడిని సంప్రదించండి.',
        deepLink: '/Screen/attendance',
        requiredParams: ['studentName', 'attendancePct', 'threshold']
    },

    // ===== BATCH 2: SUBSTITUTION =====
    SUBSTITUTION_ASSIGNED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📋 Substitution Assigned',
        titleTemplate_te: '📋 సబ్‌స్టిట్యూషన్ కేటాయింపు',
        bodyTemplate: 'You have been assigned Period {{periodNumber}}, {{className}} {{subjectName}}, covering for {{originalTeacher}} on {{date}}.',
        bodyTemplate_te: 'మీకు {{date}} న {{originalTeacher}} బదులుగా పీరియడ్ {{periodNumber}}, {{className}} {{subjectName}} కేటాయించబడింది.',
        deepLink: '/staff/timetable',
        requiredParams: ['periodNumber', 'className', 'subjectName', 'originalTeacher', 'date']
    },

    // ===== BATCH 2: TRANSPORT SAFETY & SAFEGUARDING =====
    TRANSPORT_OVERSPEED_ALERT: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '🚨 Vehicle Overspeed Alert',
        titleTemplate_te: '🚨 వాహనం మితిమీరిన వేగం హెచ్చరిక',
        bodyTemplate: 'Bus {{busNo}} exceeded speed limit! Speed: {{speed}} km/h (Limit: {{limit}} km/h) near {{location}}.',
        bodyTemplate_te: 'బస్ {{busNo}} వేగ పరిమితిని మించింది! వేగం: {{speed}} km/h (పరిమితి: {{limit}} km/h).',
        deepLink: '/admin/transport',
        requiredParams: ['busNo', 'speed', 'limit']
    },
    TRANSPORT_SOS_ALERT: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '🆘 DRIVER EMERGENCY SOS',
        titleTemplate_te: '🆘 డ్రైవర్ అత్యవసర SOS',
        bodyTemplate: 'EMERGENCY SOS triggered by driver {{driverName}} on Bus {{busNo}} (Route: {{routeName}})! Immediate response required.',
        bodyTemplate_te: 'బస్ {{busNo}} (రూట్: {{routeName}}) పై డ్రైవర్ {{driverName}} అత్యవసర SOS ట్రిగ్గర్ చేసారు!',
        deepLink: '/admin/transport',
        requiredParams: ['driverName', 'busNo', 'routeName']
    },
    TRANSPORT_SAFEGUARDING_ANOMALY: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '⚠️ Student Safeguarding Anomaly',
        titleTemplate_te: '⚠️ విద్యార్థి భద్రతా వ్యత్యాసం',
        bodyTemplate: 'Safeguarding Alert: {{studentName}} was recorded on the morning bus but marked absent in classroom. Verification required.',
        bodyTemplate_te: 'భద్రతా హెచ్చరిక: {{studentName}} ఉదయం బస్సులో ఎక్కినట్లు నమోదైంది కానీ తరగతి గదిలో గైర్హాజరుగా ఉంది. దయచేసి పరిశీలించండి.',
        deepLink: '/admin/transport',
        requiredParams: ['studentName', 'className']
    },

    // ===== BATCH 2: PARENT HELP DESK =====
    SUPPORT_TICKET_CREATED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '🎫 Support Request Received',
        titleTemplate_te: '🎫 సపోర్ట్ అభ్యర్థన అందింది',
        bodyTemplate: 'Ticket {{ticketNumber}} ({{category}}): "{{subject}}" has been received.',
        bodyTemplate_te: 'టికెట్ {{ticketNumber}} ({{category}}): "{{subject}}" నమోదు చేయబడింది.',
        deepLink: '/Screen/helpdesk',
        requiredParams: ['ticketNumber', 'category', 'subject']
    },
    SUPPORT_TICKET_REPLIED: {
        channelId: 'notification_default',
        sound: 'notification_default.wav',
        titleTemplate: '💬 Support Ticket Update',
        titleTemplate_te: '💬 సపోర్ట్ టికెట్ నవీకరణ',
        bodyTemplate: 'New reply on Ticket {{ticketNumber}} ({{category}}): "{{messageSnippet}}"',
        bodyTemplate_te: 'టికెట్ {{ticketNumber}} పై కొత్త సమాధానం: "{{messageSnippet}}"',
        deepLink: '/Screen/helpdesk',
        requiredParams: ['ticketNumber', 'category', 'messageSnippet']
    },
    POPUP_ANNOUNCEMENT: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📢 School update',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '📢 పాఠశాల నవీకరణ',
        bodyTemplate_te: '{{message_te}}',
        deepLink: '/updates',
        requiredParams: ['message']
    },

    SUPPORT_TICKET_RESOLVED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '✅ Support Request Resolved',
        titleTemplate_te: '✅ సపోర్ట్ అభ్యర్థన పరిష్కరించబడింది',
        bodyTemplate: 'Ticket {{ticketNumber}} ({{category}}) has been resolved.',
        bodyTemplate_te: 'టికెట్ {{ticketNumber}} ({{category}}) పరిష్కరించబడింది.',
        deepLink: '/Screen/helpdesk',
        requiredParams: ['ticketNumber', 'category']
    },

    VISITOR_REQUEST_PENDING: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Campus visit request',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'క్యాంపస్ సందర్శన అభ్యర్థన',
        bodyTemplate_te: '{{message}}',
        deepLink: '/admin/visitors/approvals',
        requiredParams: ['message']
    },
    VISITOR_REQUEST_APPROVED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Campus visit approved',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'క్యాంపస్ సందర్శన ఆమోదించబడింది',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/visitorPass',
        requiredParams: ['message']
    },
    VISITOR_REQUEST_REJECTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Campus visit declined',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'క్యాంపస్ సందర్శన తిరస్కరించబడింది',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/visitSchool',
        requiredParams: ['message']
    },
    VISITOR_ARRIVED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Visitor arrived',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'సందర్శకుడు వచ్చారు',
        bodyTemplate_te: '{{message}}',
        deepLink: '/admin/visitors/live',
        requiredParams: ['message']
    },
    VISITOR_WAITING_AT_GATE: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: 'Visitor waiting at gate',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'గేట్ వద్ద సందర్శకుడు వేచి ఉన్నారు',
        bodyTemplate_te: '{{message}}',
        deepLink: '/admin/visitors/approvals',
        requiredParams: ['message']
    },
    VISITOR_OVERSTAYED: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: 'Visitor overstay',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'సందర్శకుడు ఎక్కువసేపు ఉన్నారు',
        bodyTemplate_te: '{{message}}',
        deepLink: '/admin/visitors/live',
        requiredParams: ['message']
    },
    DELIVERY_RECEIVED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Package received at gate',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'గేట్ వద్ద ప్యాకేజీ అందింది',
        bodyTemplate_te: '{{message}}',
        deepLink: '/gatekeeper/deliveries',
        requiredParams: ['message']
    },
    STUDENT_RELEASED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Student released',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'విద్యార్థి విడుదలయ్యారు',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/studentPickup',
        requiredParams: ['message']
    },
    SECURITY_ALERT: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: 'Security alert',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'భద్రతా హెచ్చరిక',
        bodyTemplate_te: '{{message}}',
        deepLink: '/admin/visitors',
        requiredParams: ['message']
    },

    // ===== ACADEMIC CALENDAR & SCHEDULING =====
    CALENDAR_EVENT_PUBLISHED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📅 New Event: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '📅 కొత్త ఈవెంట్: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/calendar',
        requiredParams: ['title', 'message']
    },
    CALENDAR_EVENT_REMINDER: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '⏰ Reminder: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '⏰ రిమైండర్: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/calendar',
        requiredParams: ['title', 'message']
    },
    CALENDAR_EVENT_UPDATED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🔄 Event Updated: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '🔄 ఈవెంట్ మార్చబడింది: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/calendar',
        requiredParams: ['title', 'message']
    },
    CALENDAR_EVENT_CANCELLED: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '❌ Event Cancelled: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '❌ ఈవెంట్ రద్దు చేయబడింది: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/calendar',
        requiredParams: ['title', 'message']
    },
    HOLIDAY_ANNOUNCED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🏖️ Holiday Announcement',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '🏖️ సెలవు ప్రకటన',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/calendar',
        requiredParams: ['message']
    },

    EVENT_PUBLISHED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📅 Event: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '📅 ఈవెంట్: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/events',
        requiredParams: ['title', 'message']
    },
    EVENT_CONSENT_PENDING: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Consent needed: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'సమ్మతి అవసరం: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/events',
        requiredParams: ['title', 'message']
    },
    EVENT_PAYMENT_PENDING: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Event fee pending: {{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'ఈవెంట్ రుసుము బాకీ: {{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/events',
        requiredParams: ['title', 'message']
    },
    CRITICAL_INCIDENT: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '{{title}}',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '{{title}}',
        bodyTemplate_te: '{{message}}',
        deepLink: '/admin/events',
        requiredParams: ['title', 'message']
    },

    // ===== ADMISSIONS & ENQUIRIES =====
    ADMISSION_APPLICATION_SUBMITTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Admission Application Submitted',
        bodyTemplate: 'Application {{application_no}} has been submitted successfully for {{student_name}}.',
        titleTemplate_te: 'ప్రవేశ దరఖాస్తు సమర్పించబడింది',
        bodyTemplate_te: '{{student_name}} కొరకు దరఖాస్తు {{application_no}} విజయవంతంగా సమర్పించబడింది.',
        deepLink: '/admission/dashboard',
        requiredParams: ['application_no', 'student_name']
    },
    ADMISSION_DOC_VERIFIED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Document Verified',
        bodyTemplate: 'Your document {{doc_name}} has been verified.',
        titleTemplate_te: 'పత్రం ధృవీకరించబడింది',
        bodyTemplate_te: 'మీ పత్రం {{doc_name}} విజయవంతంగా ధృవీకరించబడింది.',
        deepLink: '/admission/dashboard',
        requiredParams: ['doc_name']
    },
    ADMISSION_DOC_REJECTED: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: 'Action Required: Document Re-upload',
        bodyTemplate: 'Document {{doc_name}} was rejected: {{reason}}. Please re-upload.',
        titleTemplate_te: 'చర్య అవసరం: పత్రాన్ని తిరిగి అప్‌లోడ్ చేయండి',
        bodyTemplate_te: 'పత్రం {{doc_name}} తిరస్కరించబడింది: {{reason}}. దయచేసి తిరిగి అప్‌లోడ్ చేయండి.',
        deepLink: '/admission/dashboard',
        requiredParams: ['doc_name', 'reason']
    },
    ADMISSION_INTERVIEW_SCHEDULED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Interaction Scheduled',
        bodyTemplate: 'Admission interaction scheduled on {{date}} at {{time}}.',
        titleTemplate_te: 'ఇంటరాక్షన్ షెడ్యూల్ చేయబడింది',
        bodyTemplate_te: 'ప్రవేశ ఇంటరాక్షన్ {{date}} న {{time}} కి షెడ్యూల్ చేయబడింది.',
        deepLink: '/admission/dashboard',
        requiredParams: ['date', 'time']
    },
    ADMISSION_APPROVED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Admission Approved! 🎉',
        bodyTemplate: 'Congratulations! Application {{application_no}} has been approved.',
        titleTemplate_te: 'ప్రవేశం ఆమోదించబడింది! 🎉',
        bodyTemplate_te: 'అభినందనలు! దరఖాస్తు {{application_no}} ఆమోదించబడింది.',
        deepLink: '/admission/dashboard',
        requiredParams: ['application_no']
    },
    ADMISSION_CONFIRMED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Admission Confirmed',
        bodyTemplate: 'Student enrolled successfully with Admission No {{admission_no}}.',
        titleTemplate_te: 'ప్రవేశం ఖరారైంది',
        bodyTemplate_te: 'ప్రవేశ సంఖ్య {{admission_no}} తో విద్యార్థి నమోదు విజయవంతమైంది.',
        deepLink: '/admission/dashboard',
        requiredParams: ['admission_no']
    },
    ADMISSION_SLA_BREACH: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: '⚠️ Admission SLA Breach Alert',
        bodyTemplate: 'Application {{application_no}} has breached SLA.',
        titleTemplate_te: '⚠️ ప్రవేశ SLA ఉల్లంఘన హెచ్చరిక',
        bodyTemplate_te: 'దరఖాస్తు {{application_no}} SLA ను ఉల్లంఘించింది.',
        deepLink: '/admin/admissions',
        requiredParams: ['application_no']
    },
    ADMISSION_REMINDER: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Admission reminder',
        bodyTemplate: 'Application {{application_no}} still needs action. Status: {{status}}.',
        titleTemplate_te: 'ప్రవేశ రిమైండర్',
        bodyTemplate_te: 'దరఖాస్తు {{application_no}} ఇంకా చర్య అవసరం. స్థితి: {{status}}.',
        deepLink: '/admission/dashboard',
        requiredParams: ['application_no', 'status']
    },
    ADMISSION_WAITLISTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Waitlisted',
        bodyTemplate: 'Application {{application_no}} has been waitlisted.',
        titleTemplate_te: 'వెయిట్‌లిస్ట్',
        bodyTemplate_te: 'దరఖాస్తు {{application_no}} వెయిట్‌లిస్ట్ చేయబడింది.',
        deepLink: '/admission/dashboard',
        requiredParams: ['application_no']
    },
    ADMISSION_REJECTED: {
        channelId: 'emergency',
        sound: 'emergency.wav',
        titleTemplate: 'Admission update',
        bodyTemplate: 'Application {{application_no}} was not approved.',
        titleTemplate_te: 'ప్రవేశ నవీకరణ',
        bodyTemplate_te: 'దరఖాస్తు {{application_no}} ఆమోదించబడలేదు.',
        deepLink: '/admission/dashboard',
        requiredParams: ['application_no']
    },

    INTELLIGENCE_PATTERN_DETECTED: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Student pattern ready for review',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'విద్యార్థి నమూనా సమీక్షకు సిద్ధం',
        bodyTemplate_te: '{{message}}',
        deepLink: '/staff/student-intelligence',
        requiredParams: ['message']
    },
    ANECDOTE_FOLLOWUP_DUE: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Follow-up due',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'ఫాలో-అప్ గడువు',
        bodyTemplate_te: '{{message}}',
        deepLink: '/staff/anecdotes',
        requiredParams: ['message']
    },
    INTERVENTION_REVIEW_DUE: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: 'Intervention review',
        bodyTemplate: '{{message}}',
        titleTemplate_te: 'మధ్యవర్తిత్వ సమీక్ష',
        bodyTemplate_te: '{{message}}',
        deepLink: '/staff/student-intelligence',
        requiredParams: ['message']
    },

    // ===== CONTENT ENGINE (DAILY THOUGHT & NEWS) =====
    DAILY_THOUGHT: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '🌅 Today\'s Thought',
        bodyTemplate: '{{message}}',
        titleTemplate_te: '🌅 నేటి ఆలోచన',
        bodyTemplate_te: '{{message}}',
        deepLink: '/Screen/schoolDaily',
        requiredParams: ['message']
    },
    DAILY_NEWS: {
        channelId: 'voice_alert',
        sound: 'voice_alert.wav',
        titleTemplate: '📰 Today\'s News',
        bodyTemplate: '{{title}} — {{message}}',
        titleTemplate_te: '📰 నేటి వార్తలు',
        bodyTemplate_te: '{{title}} — {{message}}',
        deepLink: '/Screen/schoolDaily',
        requiredParams: ['title', 'message']
    }

});

