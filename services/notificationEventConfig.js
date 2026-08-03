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
        deepLink: '/results',
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
        deepLink: '/Screen/timetable',
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
        deepLink: '/Screen/access',
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
        bodyTemplate: '🚌 Your child\'s school bus has started its journey. Bus will arrive at {{stopName}} shortly.',
        bodyTemplate_te: '🚌 మీ పిల్లల పాఠశాల బస్ ప్రయాణం ప్రారంభమైంది. బస్ {{stopName}} వద్ద త్వరలో చేరుకుంటుంది.',
        deepLink: '/Screen/busTracker',
        requiredParams: ['stopName']
    },

    TRANSPORT_BUS_APPROACHING: {
        // Dedicated channel: Android notification-channel sound is authoritative.
        // The same full filename is used by APNs on iOS.
        channelId: 'bus_confirmation',
        sound: 'busconfirmation.wav',
        titleTemplate: '🚌 Bus One Stop Away',
        titleTemplate_te: '🚌 బస్ ఒక స్టాప్ దూరంలో ఉంది',
        bodyTemplate: '🚌 School bus is one stop away from {{stopName}}. Please be ready.',
        bodyTemplate_te: '🚌 పాఠశాల బస్ {{stopName}}కు ముందు స్టాప్ వద్ద ఉంది. దయచేసి సిద్ధంగా ఉండండి.',
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
    }

});
