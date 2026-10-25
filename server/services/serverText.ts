import { DateTime } from "luxon";

/**
 * Sentences the SERVER writes (the access log, the health timeline). They are
 * produced in the language the person chose for their account, so the
 * interface never mixes Arabic with English sentences it cannot translate.
 * English is the fallback. Doctor-written text and names are never altered.
 */
export type Lang = "en" | "ar";

type Vars = Record<string, string | number>;

const EN = {
  someone: "Someone",
  you: "You",
  yourDoctor: "your doctor",
  // Access log
  "audit.doctor.viewed_paired_patient": "{a} read what you wrote when you asked for help",
  "audit.doctor.viewed_shared_records": "{a} looked at the records you chose to share with them",
  "audit.document.viewed": "{a} opened one of your documents",
  "audit.care_circle.viewed_patient": "{a} looked at your Care Circle page",
  "audit.pairing.requested": "You asked a doctor to see you",
  "audit.pairing.accepted": "{a} accepted you as a patient",
  "audit.pairing.declined": "{a} declined your request",
  "audit.pairing.cancelled": "You cancelled a request to a doctor",
  "audit.pairing.ended": "You stopped sharing with a doctor",
  "audit.sharing_grant.updated": "You changed what a doctor can see",
  "audit.sharing_grant.revoked": "You took back extra access from a doctor",
  "audit.care_circle.invited": "You invited someone to your Care Circle",
  "audit.care_circle.accepted": "{a} joined your Care Circle",
  "audit.care_circle.permissions_updated": "You changed what someone in your Care Circle can see",
  "audit.care_circle.revoked": "You removed someone from your Care Circle",
  "audit.document.uploaded": "You saved a document",
  "audit.document.deleted": "You deleted a document",
  "audit.emergency_profile.updated": "You updated your emergency information",
  // Timeline
  "tl.appt.completed": "Appointment with {name} completed",
  "tl.appt.confirmed": "Appointment confirmed with {name}",
  "tl.appt.cancelled": "Appointment with {name} cancelled",
  "tl.appt.requested": "Appointment requested with {name}",
  "tl.visitSummary": "Visit summary from {name}",
  "tl.followUpIncluded": "Follow-up instructions included",
  "tl.rx.new": "New prescription: {med}",
  "tl.rx.by": "Prescribed by {name}",
  "tl.med.started": "Started tracking {med}",
  "tl.med.daily": "{count}x daily",
  "tl.pharm": "Pharmacy order {status}",
  "tl.pharm.delivery": "Home delivery (demo)",
  "tl.pharm.pickup": "Pickup (demo)",
  "tl.doc.added": "Document added: {title}",
  "tl.followUp.done": "Completed",
  "tl.followUp.task": "Follow-up task",
  "tl.connected": "Connected with {name}",
  "tl.careTeam": "Added to your care team",
  // Words used inside the above
  "type.Video Visit": "Video Visit",
  "type.Phone Call": "Phone Call",
  "type.In-Person": "In-Person",
  "status.received": "received",
  "status.processing": "processing",
  "status.preparing": "preparing",
  "status.ready_for_pickup": "ready for pickup",
  "status.out_for_delivery": "out for delivery",
  "status.delivered": "delivered",
  "status.picked_up": "picked up",
  "cat.Lab Result": "Lab Result",
  "cat.Imaging": "Imaging",
  "cat.Visit Summary": "Visit Summary",
  "cat.Insurance": "Insurance",
  "cat.Other": "Other",
} as const;

const AR: Partial<Record<keyof typeof EN, string>> = {
  someone: "شخص ما",
  you: "أنت",
  yourDoctor: "طبيبك",
  "audit.doctor.viewed_paired_patient": "اطّلع {a} على ما كتبته عندما طلبت المساعدة",
  "audit.doctor.viewed_shared_records": "اطّلع {a} على السجلات التي اخترت مشاركتها معه",
  "audit.document.viewed": "فتح {a} أحد مستنداتك",
  "audit.care_circle.viewed_patient": "اطّلع {a} على صفحة دائرة رعايتك",
  "audit.pairing.requested": "طلبتَ من طبيب أن يعاينك",
  "audit.pairing.accepted": "قبلك {a} كمريض",
  "audit.pairing.declined": "رفض {a} طلبك",
  "audit.pairing.cancelled": "ألغيتَ طلبًا موجّهًا إلى طبيب",
  "audit.pairing.ended": "أوقفتَ المشاركة مع طبيب",
  "audit.sharing_grant.updated": "غيّرتَ ما يستطيع الطبيب رؤيته",
  "audit.sharing_grant.revoked": "سحبتَ صلاحية إضافية من طبيب",
  "audit.care_circle.invited": "دعوتَ شخصًا إلى دائرة رعايتك",
  "audit.care_circle.accepted": "انضم {a} إلى دائرة رعايتك",
  "audit.care_circle.permissions_updated": "غيّرتَ ما يستطيع شخص في دائرة رعايتك رؤيته",
  "audit.care_circle.revoked": "أزلتَ شخصًا من دائرة رعايتك",
  "audit.document.uploaded": "حفظتَ مستندًا",
  "audit.document.deleted": "حذفتَ مستندًا",
  "audit.emergency_profile.updated": "حدّثتَ معلومات الطوارئ الخاصة بك",
  "tl.appt.completed": "اكتمل الموعد مع {name}",
  "tl.appt.confirmed": "تم تأكيد الموعد مع {name}",
  "tl.appt.cancelled": "أُلغي الموعد مع {name}",
  "tl.appt.requested": "طُلب موعد مع {name}",
  "tl.visitSummary": "ملخص الزيارة من {name}",
  "tl.followUpIncluded": "تتضمن تعليمات للمتابعة",
  "tl.rx.new": "وصفة طبية جديدة: {med}",
  "tl.rx.by": "وصفها {name}",
  "tl.med.started": "بدأت متابعة {med}",
  "tl.med.daily": "{count} مرات يوميًا",
  "tl.pharm": "طلب الصيدلية: {status}",
  "tl.pharm.delivery": "توصيل إلى المنزل (تجريبي)",
  "tl.pharm.pickup": "استلام من الصيدلية (تجريبي)",
  "tl.doc.added": "أُضيف مستند: {title}",
  "tl.followUp.done": "مكتملة",
  "tl.followUp.task": "مهمة متابعة",
  "tl.connected": "تم الاتصال مع {name}",
  "tl.careTeam": "أُضيف إلى فريق رعايتك",
  "type.Video Visit": "زيارة بالفيديو",
  "type.Phone Call": "مكالمة هاتفية",
  "type.In-Person": "حضوري",
  "status.received": "تم الاستلام",
  "status.processing": "قيد المعالجة",
  "status.preparing": "قيد التحضير",
  "status.ready_for_pickup": "جاهز للاستلام",
  "status.out_for_delivery": "في الطريق",
  "status.delivered": "تم التسليم",
  "status.picked_up": "تم الاستلام من الصيدلية",
  "cat.Lab Result": "نتيجة مختبر",
  "cat.Imaging": "تصوير طبي",
  "cat.Visit Summary": "ملخص زيارة",
  "cat.Insurance": "تأمين",
  "cat.Other": "أخرى",
};

export type TextKey = keyof typeof EN;

export function normalizeLang(value: string | null | undefined): Lang {
  return value === "ar" ? "ar" : "en";
}

export function st(lang: Lang, key: TextKey, vars?: Vars): string {
  const template = (lang === "ar" ? AR[key] : undefined) ?? EN[key];
  return vars ? template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : template;
}

/** A stored word (appointment type, document category, order status) in the reader's language; unknown values pass through. */
export function stWord(lang: Lang, prefix: "type" | "cat" | "status", value: string): string {
  const key = `${prefix}.${value}` as TextKey;
  return key in EN ? st(lang, key) : value.replace(/_/g, " ");
}

/** "Oct 28, 3:57 PM" / "٢٨ أكتوبر، ٣:٥٧ م" style, in the person's zone and language (Western digits for Arabic). */
export function stDateTime(lang: Lang, date: Date | string, zone: string): string {
  return DateTime.fromJSDate(new Date(date), { zone })
    .setLocale(lang === "ar" ? "ar-u-nu-latn" : "en-US")
    .toLocaleString({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
