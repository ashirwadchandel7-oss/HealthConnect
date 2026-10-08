const menuButton=document.querySelector('.menu-toggle');
const mainNav=document.querySelector('.nav');
const closeMenu=()=>{menuButton?.setAttribute('aria-expanded','false');mainNav?.classList.remove('open');};
menuButton?.addEventListener('click',()=>{const open=menuButton.getAttribute('aria-expanded')==='true';menuButton.setAttribute('aria-expanded',String(!open));mainNav?.classList.toggle('open',!open);});
const closeMenuWhenOutside=(event)=>{
  const isOpen=menuButton?.getAttribute('aria-expanded')==='true'||mainNav?.classList.contains('open');
  if(isOpen&&!mainNav?.contains(event.target)&&!menuButton?.contains(event.target))closeMenu();
};
// Capture the interaction so other page handlers cannot prevent outside taps from closing the menu.
document.addEventListener('pointerdown',closeMenuWhenOutside,true);
document.addEventListener('click',closeMenuWhenOutside,true);
document.addEventListener('keydown',(event)=>{if(event.key==='Escape')closeMenu();});
mainNav?.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));

document.querySelectorAll('[data-password-toggle]').forEach((button)=>{
  const input=button.closest('.password-input-wrap')?.querySelector('input');
  if(!input)return;
  const eye='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOff='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.7 10.7 0 0 0 4-.8"/></svg>';
  button.addEventListener('click',()=>{
    const show=input.type==='password';
    input.type=show?'text':'password';
    button.setAttribute('aria-label',show?'Hide password':'Show password');
    button.title=show?'Hide password':'Show password';
    button.innerHTML=show?eyeOff:eye;
  });
});

document.querySelectorAll('.flash').forEach((notice)=>{
  const closeButton=notice.querySelector('.flash-close');
  const timer=window.setTimeout(()=>notice.remove(),120000);
  closeButton?.addEventListener('click',()=>{window.clearTimeout(timer);notice.remove();});
});

// Keep profile save actions hidden until a user changes a field.
document.querySelectorAll('form[data-change-save]').forEach((form)=>{
  const button=form.querySelector('[data-change-submit]');
  if(!button)return;
  const getState=()=>JSON.stringify([...new FormData(form).entries()]
    .filter(([name])=>name!=='_csrf')
    .map(([name,value])=>[name,typeof value==='string'?value:value.name]));
  const initialState=getState();
  const sync=()=>{
    const changed=getState()!==initialState;
    button.hidden=!changed;
    button.style.display=changed?'':'none';
  };
  form.addEventListener('input',sync);
  form.addEventListener('change',sync);
  sync();
});

document.querySelectorAll('[data-otp-countdown]').forEach((button) => {
  const label = button.querySelector('[data-countdown-label]');
  const readyLabel = button.dataset.readyLabel || 'Resend code';
  const prefix = button.dataset.countdownPrefix || 'Resend code in ';
  let secondsRemaining = Math.max(0, Number.parseInt(button.dataset.seconds || '0', 10) || 0);
  let timerId;

  const updateCountdown = () => {
    button.disabled = secondsRemaining > 0;
    if (secondsRemaining <= 0) {
      if (label) label.textContent = readyLabel;
      if (timerId) window.clearInterval(timerId);
      return;
    }

    const minutes = Math.floor(secondsRemaining / 60);
    const seconds = String(secondsRemaining % 60).padStart(2, '0');
    if (label) label.textContent = `${prefix}${minutes}:${seconds}`;
    secondsRemaining -= 1;
  };

  const hasCountdown = secondsRemaining > 0;
  updateCountdown();
  if (hasCountdown) timerId = window.setInterval(updateCountdown, 1000);
});

document.querySelector('[data-back-button]')?.addEventListener('click', () => {
  const currentUrl = new URL(window.location.href);
  const currentPath = currentUrl.pathname;
  if (currentPath === '/') return;
  if (currentPath === '/settings' && currentUrl.searchParams.get('back') === 'home') {
    window.location.assign('/');
    return;
  }

  let sameSiteReferrer = false;
  try { sameSiteReferrer = Boolean(document.referrer) && new URL(document.referrer).origin === window.location.origin; } catch {}
  if (sameSiteReferrer && window.history.length > 1) {
    window.history.back();
    return;
  }

  const sectionPages = ['/profile', '/my-appointments', '/records', '/health-assistant'];
  const fallback = sectionPages.includes(currentPath) ? '/settings?back=home' : '/';
  window.location.assign(fallback);
});

const role=document.querySelector('#register-form select[name="role"]');

function updateRoleFields(){
  if(!role)return;
  document.querySelectorAll('.role-fields').forEach(group=>{
    const visible=group.dataset.role.split(' ').includes(role.value);
    group.hidden=!visible;
    group.querySelectorAll('input,select,textarea').forEach(field=>{
      field.disabled=!visible;
      field.required=visible && Boolean(field.closest("label")?.hasAttribute("data-required"));
    });
  });
}

role?.addEventListener('change',updateRoleFields);
updateRoleFields();

document.querySelectorAll('[data-qualification-selector]').forEach((group)=>{
  const choices=[...group.querySelectorAll('input[name="doctorQualifications"]')];
  const valueInput=group.querySelector('[data-qualification-value]');
  const message=group.querySelector('[data-qualification-message]');
  const sync=()=>{
    const selected=choices.filter((choice)=>choice.checked).map((choice)=>choice.value);
    valueInput.value=selected.join(' · ');
    choices.forEach((choice)=>{choice.required=false;});
    choices[0]?.setCustomValidity(role?.value==='doctor'&&selected.length===0?'Select at least one qualification.':'');
    if(message)message.textContent=selected.length
      ? `${selected.length} of 3 qualifications selected.`
      : 'Select at least one qualification. Your account remains pending until an administrator reviews your documents.';
  };
  choices.forEach((choice)=>choice.addEventListener('change',(event)=>{
    const selectedCount=choices.filter((item)=>item.checked).length;
    if(selectedCount>3){
      event.currentTarget.checked=false;
      if(message)message.textContent='You can select up to three qualifications.';
    }
    sync();
  }));
  role?.addEventListener('change',sync);
  sync();
});

// Site-language translations are local and persistent; patient-entered data stays untouched.
(() => {
  const hindiDictionary = {
    'Home':'होम','Healthcare':'स्वास्थ्य सेवाएँ','Doctors':'डॉक्टर','Hospitals':'अस्पताल','About':'हमारे बारे में','My appointments':'मेरे अपॉइंटमेंट','Consultations':'परामर्श',
    'Account controls':'खाता नियंत्रण','Manage your profile, open your account sections, and choose your website language.':'अपनी प्रोफ़ाइल और खाते के अनुभाग खोलें और वेबसाइट की भाषा चुनें।',
    'View or edit your account details and profile picture.':'अपने खाते की जानकारी और प्रोफ़ाइल तस्वीर देखें या बदलें।','Your care summary and next appointment.':'आपकी स्वास्थ्य जानकारी और अगला अपॉइंटमेंट।',
    'Open your bookings and appointment proofs.':'अपनी बुकिंग और अपॉइंटमेंट प्रमाण देखें।','View your saved medical records.':'अपने सुरक्षित मेडिकल रिकॉर्ड देखें।',
    'Your practice summary and account status.':'आपकी प्रैक्टिस की जानकारी और खाते की स्थिति।','Review your patient appointments.':'अपने मरीज़ों के अपॉइंटमेंट देखें।',
    'Open records linked to your appointments.':'अपॉइंटमेंट से जुड़े रिकॉर्ड खोलें।','Open the separate AI health chat.':'AI स्वास्थ्य चैट खोलें।','Your organisation status and activity.':'आपकी संस्था की स्थिति और गतिविधियाँ।',
    'Upcoming appointments with affiliated doctors.':'संबद्ध डॉक्टरों के आने वाले अपॉइंटमेंट।','Open the administration dashboard.':'एडमिन डैशबोर्ड खोलें।',
    'Review online consultation activity and billing.':'ऑनलाइन परामर्श गतिविधि और बिलिंग देखें।','Choose the language used for website interface text.':'वेबसाइट के इंटरफ़ेस की भाषा चुनें।',
    'Sign in':'साइन इन','Create account':'खाता बनाएँ','Find a doctor':'डॉक्टर खोजें','Find a hospital':'अस्पताल खोजें',
    'Online consultations':'ऑनलाइन परामर्श','Overview':'अवलोकन','Health assistant':'स्वास्थ्य सहायक','Appointments':'अपॉइंटमेंट',
    'Records':'रिकॉर्ड','Prescriptions':'प्रिस्क्रिप्शन','Notifications':'सूचनाएँ','Verification':'सत्यापन','UPI payments':'UPI भुगतान',
    'Availability':'उपलब्धता','Patients':'मरीज़','Messages':'संदेश','Dashboard':'डैशबोर्ड','Sign out':'साइन आउट',
    'Profile':'प्रोफ़ाइल','Language':'भाषा','Settings':'सेटिंग्स','English':'अंग्रेज़ी','Hindi':'हिन्दी','Back':'वापस',
    'Create your account':'अपना खाता बनाएँ','Already have an account?':'क्या आपका पहले से खाता है?','I am joining as':'मैं इस रूप में जुड़ रहा/रही हूँ',
    'Choose account type':'खाते का प्रकार चुनें','Full name':'पूरा नाम','Phone number':'फ़ोन नंबर','Email address':'ईमेल पता',
    'Password':'पासवर्ड','Confirm password':'पासवर्ड की पुष्टि करें','Forgot password?':'पासवर्ड भूल गए?',
    'Medical specialty':'चिकित्सा विशेषज्ञता','City':'शहर','Qualification':'योग्यता','Medical registration number':'मेडिकल पंजीकरण नंबर',
    'Create account →':'खाता बनाएँ →','Create account ↗':'खाता बनाएँ ↗','Save profile':'प्रोफ़ाइल सहेजें','Save picture':'तस्वीर सहेजें',
    'Update profile picture':'प्रोफ़ाइल तस्वीर अपडेट करें','Your account and care activity.':'आपका खाता और स्वास्थ्य गतिविधियाँ।',
    'My patient profile':'मेरी मरीज़ प्रोफ़ाइल','Doctor profile and professional details':'डॉक्टर प्रोफ़ाइल और पेशेवर जानकारी',
    'Account status:':'खाते की स्थिति:','verified':'सत्यापित','not verified':'सत्यापित नहीं','Your care overview':'आपकी स्वास्थ्य जानकारी',
    'Appointments today':'आज के अपॉइंटमेंट','Upcoming appointments':'आने वाले अपॉइंटमेंट','Medical records':'मेडिकल रिकॉर्ड',
    'Prescriptions':'प्रिस्क्रिप्शन','Unread notifications':'अपठित सूचनाएँ','Next appointment':'अगला अपॉइंटमेंट',
    'No upcoming appointments.':'कोई आगामी अपॉइंटमेंट नहीं है।','Patient dashboard':'मरीज़ डैशबोर्ड',
    'Doctor dashboard':'डॉक्टर डैशबोर्ड','Hospital dashboard':'अस्पताल डैशबोर्ड','Administrator review':'एडमिन समीक्षा',
    'Ask a health question':'स्वास्थ्य से जुड़ा सवाल पूछें','Your question':'आपका सवाल','Send question':'सवाल भेजें',
    'Send question →':'सवाल भेजें →','Type your question here…':'अपना सवाल यहाँ लिखें…','Speak':'बोलें','Take photo':'तस्वीर लें',
    'Choose photo':'तस्वीर चुनें','Choose from Gallery':'गैलरी से चुनें','Stop & add text':'रोकें और टेक्स्ट जोड़ें',
    'Voice language':'बोलने की भाषा','Hindi':'हिन्दी','English (India)':'अंग्रेज़ी (भारत)',
    'Find care that fits':'अपने लिए सही देखभाल खोजें','Explore doctors':'डॉक्टर देखें','Search':'खोजें','Search →':'खोजें →',
    'Search doctors or specialty':'डॉक्टर या विशेषज्ञता खोजें','Search by name, specialty or city':'नाम, विशेषज्ञता या शहर से खोजें',
    'Specialty':'विशेषज्ञता','Select a city':'शहर चुनें','All specialties':'सभी विशेषज्ञताएँ','No matching doctors yet':'अभी कोई डॉक्टर नहीं मिला',
    'Try another specialty or city.':'कोई दूसरी विशेषज्ञता या शहर चुनें।','Book appointment':'अपॉइंटमेंट बुक करें',
    'View profile and available times →':'प्रोफ़ाइल और उपलब्ध समय देखें →','Verified doctor':'सत्यापित डॉक्टर',
    'Choose a date':'तारीख चुनें','Choose a time':'समय चुनें','Consultation type':'परामर्श का प्रकार',
    'In person':'क्लिनिक में','Online':'ऑनलाइन','Continue':'आगे बढ़ें','Confirm appointment':'अपॉइंटमेंट पक्का करें',
    'Cancel':'रद्द करें','Reschedule':'समय बदलें','Download proof PDF':'सबूत PDF डाउनलोड करें',
    'Appointment confirmation':'अपॉइंटमेंट की पुष्टि','Booking reference':'बुकिंग नंबर','Payment method':'भुगतान का तरीका',
    'Cash':'नकद','UPI':'UPI','Fee':'शुल्क','Pay online':'ऑनलाइन भुगतान करें','Cash at clinic':'क्लिनिक में नकद दें',
    'Weekly schedule':'साप्ताहिक शेड्यूल','Save schedule':'शेड्यूल सहेजें','Edit schedule':'शेड्यूल बदलें',
    'Choose valid working days, hours, appointment duration and an optional break inside those hours.':'काम के दिन, समय, अपॉइंटमेंट की अवधि और चाहें तो बीच का विराम चुनें।',
    'Your profile':'आपकी प्रोफ़ाइल','My profile':'मेरी प्रोफ़ाइल','Personal details':'व्यक्तिगत जानकारी',
    'Profile saved successfully.':'प्रोफ़ाइल सफलतापूर्वक सहेजी गई।','Save changes':'बदलाव सहेजें','Edit profile':'प्रोफ़ाइल संपादित करें',
    'Administrator approval':'एडमिन की मंज़ूरी','Pending':'लंबित','Approved':'मंज़ूर','Rejected':'अस्वीकृत',
    'Care feels better connected.':'जुड़ी हुई देखभाल, बेहतर स्वास्थ्य।','Trusted care, made more human':'भरोसेमंद देखभाल, अपनापन के साथ',
    'For urgent care, contact your local emergency services.':'आपातकाल में स्थानीय आपातकालीन सेवाओं से संपर्क करें।',
    'Trusted doctors, appointments, and health details—all in one place.':'भरोसेमंद डॉक्टर, अपॉइंटमेंट और स्वास्थ्य जानकारी—सब एक जगह।',
    'No results found':'कोई नतीजा नहीं मिला','Loading…':'लोड हो रहा है…','Save':'सहेजें','Edit':'संपादित करें',
    'Close':'बंद करें','Remove image':'तस्वीर हटाएँ','Choose a JPG, PNG or WebP image up to 5 MB.':'5 MB तक की JPG, PNG या WebP तस्वीर चुनें।',
    'All rights reserved.':'सर्वाधिकार सुरक्षित।','Administrator':'एडमिन','Patient':'मरीज़','Doctor':'डॉक्टर','Hospital':'अस्पताल',
    'Website language':'वेबसाइट की भाषा','Account settings':'खाता सेटिंग्स','Trusted doctors, appointments, and health details—all in one place.':'भरोसेमंद डॉक्टर, अपॉइंटमेंट और स्वास्थ्य जानकारी—सब एक जगह।','Trusted care, made more human':'भरोसेमंद देखभाल, और अधिक अपनापन','Healthcare that feels':'ऐसी स्वास्थ्य सेवा जो लगे','simple':'सरल',', human & connected.':' , अपनापन भरी और जुड़ी हुई।','human & connected.':'अपनापन भरी और जुड़ी हुई।','Find trusted doctors, manage appointments, and keep your health details in one place.':'भरोसेमंद डॉक्टर खोजें, अपॉइंटमेंट संभालें और स्वास्थ्य जानकारी एक जगह रखें।','Browse verified doctors':'सत्यापित डॉक्टर देखें','Explore healthcare →':'स्वास्थ्य सेवाएँ देखें →','Browsing is open. Sign in with a patient account to request an appointment.':'ब्राउज़िंग खुली है। अपॉइंटमेंट के लिए मरीज़ खाते से साइन इन करें।','Helping people take the next step in care':'लोगों को देखभाल का अगला कदम लेने में मदद','YOUR CARE, IN VIEW':'आपकी देखभाल, एक नज़र में','Ready':'तैयार','Verified professional':'सत्यापित पेशेवर','Search by specialty':'विशेषज्ञता से खोजें','Browse by city':'शहर से देखें','Choose your next step':'अपना अगला कदम चुनें','Privacy first':'गोपनीयता पहले','Your records stay yours':'आपके रिकॉर्ड आपके पास सुरक्षित हैं','Easy to get started':'शुरू करना आसान','Your next step, made clear':'आपका अगला कदम साफ़ है','Find':'खोजें','care near you':'आपके पास देखभाल','the right professional':'सही पेशेवर','Connect':'जुड़ें','your care journey':'आपकी स्वास्थ्य यात्रा','Secure':'सुरक्षित','account access':'खाते तक पहुँच','A CLEARER PATH TO CARE':'देखभाल का आसान रास्ता','Care works better,':'मिलकर देखभाल बेहतर होती है,','together.':'साथ मिलकर।','Find your care':'अपनी देखभाल खोजें','Search verified healthcare professionals and discover options by specialty or city.':'सत्यापित स्वास्थ्य पेशेवरों को खोजें और विशेषज्ञता या शहर के अनुसार विकल्प देखें।','Stay organised':'व्यवस्थित रहें','Keep your account details and care journey in one simple dashboard.':'अपने खाते की जानकारी और स्वास्थ्य यात्रा एक सरल डैशबोर्ड में रखें।','Feel supported':'सहारा पाएँ','Know what to do next, with clear access to the people and services you need.':'ज़रूरी लोगों और सेवाओं तक आसान पहुँच से जानें कि आगे क्या करना है।','How it works →':'यह कैसे काम करता है →','Meet your care team':'अपनी स्वास्थ्य टीम से मिलें','near you.':'आपके पास।','Browse doctors →':'डॉक्टर देखें →'
  };
  const tamilDictionary = {
    'Home':'முகப்பு','Healthcare':'சுகாதார சேவைகள்','Doctors':'மருத்துவர்கள்','Hospitals':'மருத்துவமனைகள்','About':'எங்களைப் பற்றி','My appointments':'எனது சந்திப்புகள்','Consultations':'ஆலோசனைகள்',
    'Account controls':'கணக்கு அமைப்புகள்','Manage your profile, open your account sections, and choose your website language.':'சுயவிவரத்தை நிர்வகித்து, கணக்குப் பகுதிகளைத் திறந்து, இணையதள மொழியைத் தேர்ந்தெடுக்கவும்.','View or edit your account details and profile picture.':'கணக்கு விவரங்களையும் சுயவிவரப் படத்தையும் பார்க்கவும் அல்லது திருத்தவும்.','Your care summary and next appointment.':'உங்கள் சுகாதாரச் சுருக்கமும் அடுத்த சந்திப்பும்.','Open your bookings and appointment proofs.':'உங்கள் முன்பதிவுகளையும் சந்திப்பு ஆதாரங்களையும் திறக்கவும்.','View your saved medical records.':'சேமித்த மருத்துவப் பதிவுகளைப் பார்க்கவும்.','Your practice summary and account status.':'உங்கள் மருத்துவப் பணி சுருக்கமும் கணக்கு நிலையும்.','Review your patient appointments.':'நோயாளிகளின் சந்திப்புகளைப் பார்க்கவும்.','Open records linked to your appointments.':'சந்திப்புகளுடன் இணைக்கப்பட்ட பதிவுகளைத் திறக்கவும்.','Open the separate AI health chat.':'தனியான AI சுகாதார உரையாடலைத் திறக்கவும்.','Your organisation status and activity.':'உங்கள் நிறுவனத்தின் நிலையும் செயல்பாடுகளும்.','Upcoming appointments with affiliated doctors.':'இணைந்த மருத்துவர்களுடனான வரவிருக்கும் சந்திப்புகள்.','Open the administration dashboard.':'நிர்வாகப் பலகையைத் திறக்கவும்.','Review online consultation activity and billing.':'ஆன்லைன் ஆலோசனைகளையும் கட்டணங்களையும் பார்க்கவும்.','Choose the language used for website interface text.':'இணையதள இடைமுக மொழியைத் தேர்ந்தெடுக்கவும்.',
    'Sign in':'உள்நுழை','Create account':'கணக்கை உருவாக்கு','Find a doctor':'மருத்துவரைக் கண்டறி','Find a hospital':'மருத்துவமனையைக் கண்டறி','Online consultations':'ஆன்லைன் ஆலோசனைகள்','Overview':'கண்ணோட்டம்','Health assistant':'சுகாதார உதவியாளர்','Appointments':'சந்திப்புகள்','Records':'பதிவுகள்','Prescriptions':'மருந்துச் சீட்டுகள்','Notifications':'அறிவிப்புகள்','Verification':'சரிபார்ப்பு','UPI payments':'UPI கட்டணங்கள்','Availability':'கிடைக்கும் நேரம்','Patients':'நோயாளிகள்','Messages':'செய்திகள்','Dashboard':'பலகை','Sign out':'வெளியேறு','Profile':'சுயவிவரம்','Language':'மொழி','Settings':'அமைப்புகள்','English':'ஆங்கிலம்','Hindi':'இந்தி','Tamil':'தமிழ்','Gujarati':'குஜராத்தி','Back':'பின்செல்',
    'Create your account':'உங்கள் கணக்கை உருவாக்கவும்','Already have an account?':'ஏற்கனவே கணக்கு உள்ளதா?','I am joining as':'நான் சேர்வது','Choose account type':'கணக்கு வகையைத் தேர்ந்தெடுக்கவும்','Full name':'முழுப் பெயர்','Phone number':'தொலைபேசி எண்','Email address':'மின்னஞ்சல் முகவரி','Password':'கடவுச்சொல்','Confirm password':'கடவுச்சொல்லை உறுதிப்படுத்தவும்','Forgot password?':'கடவுச்சொல் மறந்துவிட்டதா?','Medical specialty':'மருத்துவத் துறை','City':'நகரம்','Qualification':'தகுதி','Medical registration number':'மருத்துவப் பதிவு எண்','Create account →':'கணக்கை உருவாக்கு →','Create account ↗':'கணக்கை உருவாக்கு ↗',
    'Your account and care activity.':'உங்கள் கணக்கும் சுகாதாரச் செயல்பாடுகளும்.','My patient profile':'எனது நோயாளர் சுயவிவரம்','Doctor profile and professional details':'மருத்துவர் சுயவிவரமும் தொழில்முறை விவரங்களும்','Account status:':'கணக்கு நிலை:','verified':'சரிபார்க்கப்பட்டது','not verified':'சரிபார்க்கப்படவில்லை','Your care overview':'உங்கள் சுகாதாரக் கண்ணோட்டம்','Appointments today':'இன்றைய சந்திப்புகள்','Upcoming appointments':'வரவிருக்கும் சந்திப்புகள்','Medical records':'மருத்துவப் பதிவுகள்','Unread notifications':'படிக்காத அறிவிப்புகள்','Next appointment':'அடுத்த சந்திப்பு','No upcoming appointments.':'வரவிருக்கும் சந்திப்புகள் இல்லை.','Patient dashboard':'நோயாளர் பலகை','Doctor dashboard':'மருத்துவர் பலகை','Hospital dashboard':'மருத்துவமனை பலகை','Administrator review':'நிர்வாகி மதிப்பாய்வு',
    'Ask a health question':'சுகாதாரக் கேள்வியைக் கேளுங்கள்','Your question':'உங்கள் கேள்வி','Send question':'கேள்வியை அனுப்பு','Send question →':'கேள்வியை அனுப்பு →','Type your question here…':'உங்கள் கேள்வியை இங்கே தட்டச்சு செய்யவும்…','Speak':'பேசு','Take photo':'புகைப்படம் எடு','Choose photo':'புகைப்படத்தைத் தேர்ந்தெடு','Choose from Gallery':'படத்தொகுப்பிலிருந்து தேர்ந்தெடு','Stop & add text':'நிறுத்தி உரையைச் சேர்','Voice language':'குரல் மொழி','English (India)':'ஆங்கிலம் (இந்தியா)',
    'Find care that fits':'உங்களுக்கு ஏற்ற சிகிச்சையைக் கண்டறியுங்கள்','Explore doctors':'மருத்துவர்களைப் பார்க்கவும்','Search':'தேடு','Search →':'தேடு →','Search doctors or specialty':'மருத்துவர் அல்லது துறையைத் தேடுங்கள்','Search by name, specialty or city':'பெயர், துறை அல்லது நகரம் மூலம் தேடுங்கள்','Specialty':'மருத்துவத் துறை','Select a city':'நகரத்தைத் தேர்ந்தெடுக்கவும்','All specialties':'அனைத்து மருத்துவத் துறைகளும்','No matching doctors yet':'பொருந்தும் மருத்துவர்கள் இல்லை','Try another specialty or city.':'வேறு துறை அல்லது நகரத்தைத் தேர்ந்தெடுக்கவும்.','Book appointment':'சந்திப்பைப் பதிவு செய்','View profile and available times →':'சுயவிவரத்தையும் கிடைக்கும் நேரங்களையும் காண்க →','Verified doctor':'சரிபார்க்கப்பட்ட மருத்துவர்','Choose a date':'தேதியைத் தேர்ந்தெடுக்கவும்','Choose a time':'நேரத்தைத் தேர்ந்தெடுக்கவும்','Consultation type':'ஆலோசனை வகை','In person':'நேரில்','Online':'ஆன்லைன்','Continue':'தொடர்க','Confirm appointment':'சந்திப்பை உறுதிப்படுத்து','Cancel':'ரத்து செய்','Reschedule':'நேரத்தை மாற்று','Download proof PDF':'ஆதார PDF-ஐப் பதிவிறக்கு','Appointment confirmation':'சந்திப்பு உறுதிப்படுத்தல்','Booking reference':'முன்பதிவு குறிப்பு','Payment method':'கட்டண முறை','Cash':'பணம்','UPI':'UPI','Fee':'கட்டணம்','Pay online':'ஆன்லைனில் செலுத்து','Cash at clinic':'மருத்துவமனையில் பணமாகச் செலுத்து',
    'Weekly schedule':'வார அட்டவணை','Save schedule':'அட்டவணையைச் சேமி','Edit schedule':'அட்டவணையைத் திருத்து','Your profile':'உங்கள் சுயவிவரம்','My profile':'எனது சுயவிவரம்','Personal details':'தனிப்பட்ட விவரங்கள்','Profile saved successfully.':'சுயவிவரம் வெற்றிகரமாகச் சேமிக்கப்பட்டது.','Save changes':'மாற்றங்களைச் சேமி','Edit profile':'சுயவிவரத்தைத் திருத்து','Administrator approval':'நிர்வாகி ஒப்புதல்','Pending':'நிலுவையில்','Approved':'ஒப்புதல் வழங்கப்பட்டது','Rejected':'நிராகரிக்கப்பட்டது','No results found':'முடிவுகள் இல்லை','Loading…':'ஏற்றுகிறது…','Save':'சேமி','Edit':'திருத்து','Close':'மூடு','Remove image':'படத்தை அகற்று','All rights reserved.':'அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை.','Administrator':'நிர்வாகி','Patient':'நோயாளர்','Doctor':'மருத்துவர்','Hospital':'மருத்துவமனை',
    'Website language':'இணையதள மொழி','Account settings':'கணக்கு அமைப்புகள்','Trusted doctors, appointments, and health details—all in one place.':'நம்பகமான மருத்துவர்கள், சந்திப்புகள், சுகாதார விவரங்கள்—அனைத்தும் ஒரே இடத்தில்.','Trusted care, made more human':'அன்பும் நம்பிக்கையும் நிறைந்த பராமரிப்பு','Healthcare that feels':'இப்போது சுகாதாரப் பராமரிப்பு','simple':'எளிமை',', human & connected.':' , மனிதநேயமும் இணைப்பும் கொண்டது.','human & connected.':'மனிதநேயமும் இணைப்பும் கொண்டது.','Find trusted doctors, manage appointments, and keep your health details in one place.':'நம்பகமான மருத்துவர்களைக் கண்டறிந்து, சந்திப்புகளை நிர்வகித்து, சுகாதார விவரங்களை ஒரே இடத்தில் வைத்திருங்கள்.','Browse verified doctors':'சரிபார்க்கப்பட்ட மருத்துவர்களைப் பார்க்கவும்','Explore healthcare →':'சுகாதார சேவைகளைப் பார்க்கவும் →','Browsing is open. Sign in with a patient account to request an appointment.':'இணையதளத்தைப் பார்க்கலாம். சந்திப்பைக் கோர நோயாளர் கணக்கில் உள்நுழையவும்.','Helping people take the next step in care':'சிகிச்சையின் அடுத்த படிக்கு மக்களுக்கு உதவுகிறோம்','YOUR CARE, IN VIEW':'உங்கள் சிகிச்சை, ஒரே பார்வையில்','Ready':'தயார்','Verified professional':'சரிபார்க்கப்பட்ட நிபுணர்','Search by specialty':'மருத்துவத் துறையால் தேடுங்கள்','Browse by city':'நகரத்தின் அடிப்படையில் பார்க்கவும்','Choose your next step':'உங்கள் அடுத்த படியைத் தேர்ந்தெடுங்கள்','Privacy first':'தனியுரிமை முதன்மை','Your records stay yours':'உங்கள் பதிவுகள் உங்களிடமே பாதுகாப்பாக இருக்கும்','Easy to get started':'தொடங்குவது எளிது','Your next step, made clear':'உங்கள் அடுத்த படி தெளிவாக உள்ளது','Find':'தேடுங்கள்','care near you':'உங்களுக்கு அருகிலுள்ள சிகிச்சை','the right professional':'சரியான நிபுணர்','Connect':'இணைக்கவும்','your care journey':'உங்கள் சிகிச்சைப் பயணம்','Secure':'பாதுகாப்பான','account access':'கணக்கு அணுகல்','A CLEARER PATH TO CARE':'சிகிச்சைக்கான தெளிவான பாதை','Care works better,':'ஒன்றிணைந்தால் சிகிச்சை சிறக்கும்,','together.':'ஒன்றாக.','Find your care':'உங்கள் சிகிச்சையைக் கண்டறியுங்கள்','Search verified healthcare professionals and discover options by specialty or city.':'சரிபார்க்கப்பட்ட சுகாதார நிபுணர்களைக் கண்டறிந்து, துறை அல்லது நகரத்தின் அடிப்படையில் தேர்வு செய்யுங்கள்.','Stay organised':'ஒழுங்காக வைத்திருங்கள்','Keep your account details and care journey in one simple dashboard.':'உங்கள் கணக்கு விவரங்களையும் சிகிச்சைப் பயணத்தையும் எளிய பலகையில் வைத்திருங்கள்.','Feel supported':'ஆதரவை உணருங்கள்','Know what to do next, with clear access to the people and services you need.':'உங்களுக்குத் தேவையான நபர்கள் மற்றும் சேவைகளை எளிதாக அணுகி அடுத்து என்ன செய்ய வேண்டும் என்பதை அறியுங்கள்.','How it works →':'இது எப்படிச் செயல்படுகிறது →','Meet your care team':'உங்கள் சிகிச்சைக் குழுவைச் சந்தியுங்கள்','near you.':'உங்களுக்கு அருகில்.','Browse doctors →':'மருத்துவர்களைப் பார்க்கவும் →'
  };
  const gujaratiDictionary = {
    'Home':'હોમ','Healthcare':'આરોગ્ય સેવાઓ','Doctors':'ડૉક્ટરો','Hospitals':'હૉસ્પિટલો','About':'અમારા વિશે','My appointments':'મારી મુલાકાતો','Consultations':'પરામર્શ',
    'Account controls':'ખાતા નિયંત્રણો','Manage your profile, open your account sections, and choose your website language.':'તમારી પ્રોફાઇલ સંચાલિત કરો, ખાતાના વિભાગો ખોલો અને વેબસાઇટની ભાષા પસંદ કરો.','View or edit your account details and profile picture.':'ખાતાની વિગતો અને પ્રોફાઇલ ચિત્ર જુઓ અથવા સંપાદિત કરો.','Your care summary and next appointment.':'તમારા આરોગ્યનો સારાંશ અને આગામી મુલાકાત.','Open your bookings and appointment proofs.':'તમારી બુકિંગ અને મુલાકાતના પુરાવા જુઓ.','View your saved medical records.':'સાચવેલા તબીબી રેકોર્ડ જુઓ.','Your practice summary and account status.':'તમારી પ્રેક્ટિસનો સારાંશ અને ખાતાની સ્થિતિ.','Review your patient appointments.':'તમારા દર્દીઓની મુલાકાતો જુઓ.','Open records linked to your appointments.':'મુલાકાતો સાથે જોડાયેલા રેકોર્ડ ખોલો.','Open the separate AI health chat.':'અલગ AI આરોગ્ય ચેટ ખોલો.','Your organisation status and activity.':'તમારી સંસ્થાની સ્થિતિ અને પ્રવૃત્તિ.','Upcoming appointments with affiliated doctors.':'સંલગ્ન ડૉક્ટરો સાથેની આગામી મુલાકાતો.','Open the administration dashboard.':'એડમિન ડેશબોર્ડ ખોલો.','Review online consultation activity and billing.':'ઑનલાઇન પરામર્શ અને બિલિંગ જુઓ.','Choose the language used for website interface text.':'વેબસાઇટના ઇન્ટરફેસની ભાષા પસંદ કરો.',
    'Sign in':'સાઇન ઇન','Create account':'ખાતું બનાવો','Find a doctor':'ડૉક્ટર શોધો','Find a hospital':'હૉસ્પિટલ શોધો','Online consultations':'ઑનલાઇન પરામર્શ','Overview':'ઝાંખી','Health assistant':'આરોગ્ય સહાયક','Appointments':'મુલાકાતો','Records':'રેકોર્ડ','Prescriptions':'પ્રિસ્ક્રિપ્શન','Notifications':'સૂચનાઓ','Verification':'ચકાસણી','UPI payments':'UPI ચુકવણી','Availability':'ઉપલબ્ધતા','Patients':'દર્દીઓ','Messages':'સંદેશા','Dashboard':'ડેશબોર્ડ','Sign out':'સાઇન આઉટ','Profile':'પ્રોફાઇલ','Language':'ભાષા','Settings':'સેટિંગ્સ','English':'અંગ્રેજી','Hindi':'હિન્દી','Tamil':'તમિલ','Gujarati':'ગુજરાતી','Back':'પાછા',
    'Create your account':'તમારું ખાતું બનાવો','Already have an account?':'પહેલેથી ખાતું છે?','I am joining as':'હું આ તરીકે જોડાઉં છું','Choose account type':'ખાતાનો પ્રકાર પસંદ કરો','Full name':'પૂરું નામ','Phone number':'ફોન નંબર','Email address':'ઇમેઇલ સરનામું','Password':'પાસવર્ડ','Confirm password':'પાસવર્ડની પુષ્ટિ કરો','Forgot password?':'પાસવર્ડ ભૂલી ગયા?','Medical specialty':'તબીબી વિશેષતા','City':'શહેર','Qualification':'લાયકાત','Medical registration number':'તબીબી નોંધણી નંબર','Create account →':'ખાતું બનાવો →','Create account ↗':'ખાતું બનાવો ↗',
    'Your account and care activity.':'તમારું ખાતું અને આરોગ્ય પ્રવૃત્તિ.','My patient profile':'મારી દર્દી પ્રોફાઇલ','Doctor profile and professional details':'ડૉક્ટરની પ્રોફાઇલ અને વ્યાવસાયિક વિગતો','Account status:':'ખાતાની સ્થિતિ:','verified':'ચકાસાયેલ','not verified':'ચકાસાયેલ નથી','Your care overview':'તમારા આરોગ્યની ઝાંખી','Appointments today':'આજની મુલાકાતો','Upcoming appointments':'આગામી મુલાકાતો','Medical records':'તબીબી રેકોર્ડ','Unread notifications':'ન વાંચેલી સૂચનાઓ','Next appointment':'આગામી મુલાકાત','No upcoming appointments.':'આગામી મુલાકાતો નથી.','Patient dashboard':'દર્દી ડેશબોર્ડ','Doctor dashboard':'ડૉક્ટર ડેશબોર્ડ','Hospital dashboard':'હૉસ્પિટલ ડેશબોર્ડ','Administrator review':'એડમિન સમીક્ષા',
    'Ask a health question':'આરોગ્યનો પ્રશ્ન પૂછો','Your question':'તમારો પ્રશ્ન','Send question':'પ્રશ્ન મોકલો','Send question →':'પ્રશ્ન મોકલો →','Type your question here…':'તમારો પ્રશ્ન અહીં લખો…','Speak':'બોલો','Take photo':'ફોટો લો','Choose photo':'ફોટો પસંદ કરો','Choose from Gallery':'ગેલેરીમાંથી પસંદ કરો','Stop & add text':'રોકો અને લખાણ ઉમેરો','Voice language':'અવાજની ભાષા','English (India)':'અંગ્રેજી (ભારત)',
    'Find care that fits':'તમારા માટે યોગ્ય સારવાર શોધો','Explore doctors':'ડૉક્ટરો જુઓ','Search':'શોધો','Search →':'શોધો →','Search doctors or specialty':'ડૉક્ટર અથવા વિશેષતા શોધો','Search by name, specialty or city':'નામ, વિશેષતા અથવા શહેરથી શોધો','Specialty':'વિશેષતા','Select a city':'શહેર પસંદ કરો','All specialties':'બધી વિશેષતાઓ','No matching doctors yet':'હજુ મેળ ખાતા ડૉક્ટરો નથી','Try another specialty or city.':'બીજી વિશેષતા અથવા શહેર અજમાવો.','Book appointment':'મુલાકાત બુક કરો','View profile and available times →':'પ્રોફાઇલ અને ઉપલબ્ધ સમય જુઓ →','Verified doctor':'ચકાસાયેલ ડૉક્ટર','Choose a date':'તારીખ પસંદ કરો','Choose a time':'સમય પસંદ કરો','Consultation type':'પરામર્શનો પ્રકાર','In person':'રૂબરૂ','Online':'ઑનલાઇન','Continue':'ચાલુ રાખો','Confirm appointment':'મુલાકાતની પુષ્ટિ કરો','Cancel':'રદ કરો','Reschedule':'સમય બદલો','Download proof PDF':'પુરાવાનો PDF ડાઉનલોડ કરો','Appointment confirmation':'મુલાકાતની પુષ્ટિ','Booking reference':'બુકિંગ સંદર્ભ','Payment method':'ચુકવણી પદ્ધતિ','Cash':'રોકડ','UPI':'UPI','Fee':'ફી','Pay online':'ઑનલાઇન ચૂકવો','Cash at clinic':'ક્લિનિકમાં રોકડ ચૂકવો',
    'Weekly schedule':'સાપ્તાહિક સમયપત્રક','Save schedule':'સમયપત્રક સાચવો','Edit schedule':'સમયપત્રક સંપાદિત કરો','Your profile':'તમારી પ્રોફાઇલ','My profile':'મારી પ્રોફાઇલ','Personal details':'વ્યક્તિગત વિગતો','Profile saved successfully.':'પ્રોફાઇલ સફળતાપૂર્વક સાચવાઈ.','Save changes':'ફેરફારો સાચવો','Edit profile':'પ્રોફાઇલ સંપાદિત કરો','Administrator approval':'એડમિન મંજૂરી','Pending':'બાકી','Approved':'મંજૂર','Rejected':'નામંજૂર','No results found':'કોઈ પરિણામ મળ્યું નથી','Loading…':'લોડ થઈ રહ્યું છે…','Save':'સાચવો','Edit':'સંપાદિત કરો','Close':'બંધ કરો','Remove image':'ચિત્ર દૂર કરો','All rights reserved.':'બધા હકો સુરક્ષિત.','Administrator':'એડમિન','Patient':'દર્દી','Doctor':'ડૉક્ટર','Hospital':'હૉસ્પિટલ',
    'Website language':'વેબસાઇટની ભાષા','Account settings':'ખાતા સેટિંગ્સ','Trusted doctors, appointments, and health details—all in one place.':'વિશ્વસનીય ડૉક્ટરો, મુલાકાતો અને આરોગ્યની વિગતો—બધું એક જ જગ્યાએ.','Trusted care, made more human':'વિશ્વાસભરી અને માનવીય સંભાળ','Healthcare that feels':'આરોગ્યસંભાળ જે લાગે','simple':'સરળ',', human & connected.':' , માનવીય અને જોડાયેલી.','human & connected.':'માનવીય અને જોડાયેલી.','Find trusted doctors, manage appointments, and keep your health details in one place.':'વિશ્વસનીય ડૉક્ટરો શોધો, મુલાકાતો સંભાળો અને આરોગ્યની વિગતો એક જગ્યાએ રાખો.','Browse verified doctors':'ચકાસાયેલા ડૉક્ટરો જુઓ','Explore healthcare →':'આરોગ્ય સેવાઓ જુઓ →','Browsing is open. Sign in with a patient account to request an appointment.':'બ્રાઉઝિંગ ખુલ્લું છે. મુલાકાત માટે દર્દીના ખાતાથી સાઇન ઇન કરો.','Helping people take the next step in care':'સારવારના આગલા પગલામાં લોકોને મદદ','YOUR CARE, IN VIEW':'તમારી સંભાળ, એક નજરમાં','Ready':'તૈયાર','Verified professional':'ચકાસાયેલ નિષ્ણાત','Search by specialty':'વિશેષતા પ્રમાણે શોધો','Browse by city':'શહેર પ્રમાણે જુઓ','Choose your next step':'તમારું આગળનું પગલું પસંદ કરો','Privacy first':'ગોપનીયતા પ્રથમ','Your records stay yours':'તમારા રેકોર્ડ તમારી પાસે સુરક્ષિત રહે','Easy to get started':'શરૂ કરવું સરળ','Your next step, made clear':'તમારું આગલું પગલું સ્પષ્ટ','Find':'શોધો','care near you':'તમારી નજીકની સંભાળ','the right professional':'યોગ્ય નિષ્ણાત','Connect':'જોડાઓ','your care journey':'તમારી આરોગ્યયાત્રા','Secure':'સુરક્ષિત','account access':'ખાતાની પહોંચ','A CLEARER PATH TO CARE':'સારવારનો સરળ માર્ગ','Care works better,':'સાથે મળીને સંભાળ વધુ સારી બને છે,','together.':'સાથે.','Find your care':'તમારી સારવાર શોધો','Search verified healthcare professionals and discover options by specialty or city.':'ચકાસાયેલા આરોગ્ય નિષ્ણાતોને શોધો અને વિશેષતા અથવા શહેર પ્રમાણે વિકલ્પો જુઓ.','Stay organised':'વ્યવસ્થિત રહો','Keep your account details and care journey in one simple dashboard.':'તમારી ખાતાની વિગતો અને આરોગ્યયાત્રા એક સરળ ડેશબોર્ડમાં રાખો.','Feel supported':'સહારો અનુભવો','Know what to do next, with clear access to the people and services you need.':'જરૂરી લોકો અને સેવાઓ સુધી સરળ પહોંચથી આગળ શું કરવું તે જાણો.','How it works →':'આ કેવી રીતે કાર્ય કરે છે →','Meet your care team':'તમારી સારવારની ટીમને મળો','near you.':'તમારી નજીક.','Browse doctors →':'ડૉક્ટરો જુઓ →'
  };
  const dictionaries = { hi: hindiDictionary, ta: tamilDictionary, gu: gujaratiDictionary };
  Object.assign(hindiDictionary, {
    'Explore healthcare':'स्वास्थ्य सेवाएँ देखें','All doctors':'सभी डॉक्टर','Popular:':'लोकप्रिय:','Choose':'चुनें','right professional':'सही पेशेवर','How it works':'यह कैसे काम करता है','Browse doctors':'डॉक्टर देखें','near you.':'आपके पास।',
    'Search by specialty':'विशेषज्ञता से खोजें','Browse by city':'शहर से देखें','Choose your next step':'अपना अगला कदम चुनें','Privacy first':'गोपनीयता पहले','Your records stay yours':'आपके रिकॉर्ड सुरक्षित रहते हैं','Easy to get started':'शुरू करना आसान','Your next step, made clear':'आपका अगला कदम साफ़ है','Find':'खोजें','care near you':'आपके पास देखभाल','the right professional':'सही पेशेवर','Connect':'जुड़ें','your care journey':'आपकी स्वास्थ्य यात्रा','Secure':'सुरक्षित','account access':'खाते तक पहुँच','Find trusted doctors, manage appointments, and keep your health details in one place.':'भरोसेमंद डॉक्टर खोजें, अपॉइंटमेंट संभालें और स्वास्थ्य जानकारी एक जगह रखें.','Search verified healthcare professionals and discover options by specialty or city.':'सत्यापित स्वास्थ्य पेशेवरों को खोजें और विशेषज्ञता या शहर के अनुसार विकल्प देखें।','Keep your account details and care journey in one simple dashboard.':'अपने खाते की जानकारी और स्वास्थ्य यात्रा एक सरल डैशबोर्ड में रखें।','Know what to do next, with clear access to the people and services you need.':'ज़रूरी लोगों और सेवाओं तक आसान पहुँच से जानें कि आगे क्या करना है।'
  });
  Object.assign(tamilDictionary, {
    'Explore healthcare':'சுகாதார சேவைகளைப் பார்க்கவும்','All doctors':'அனைத்து மருத்துவர்கள்','Popular:':'பிரபலமானவை:','Choose':'தேர்வு','right professional':'சரியான நிபுணர்','How it works':'இது எப்படிச் செயல்படுகிறது','Browse doctors':'மருத்துவர்களைப் பார்க்கவும்','near you.':'உங்களுக்கு அருகில்.','Search by specialty':'மருத்துவத் துறையால் தேடுங்கள்','Browse by city':'நகரத்தின் அடிப்படையில் பார்க்கவும்','Choose your next step':'உங்கள் அடுத்த படியைத் தேர்ந்தெடுங்கள்','Privacy first':'தனியுரிமை முதன்மை','Your records stay yours':'உங்கள் பதிவுகள் உங்களிடமே பாதுகாப்பாக இருக்கும்','Easy to get started':'தொடங்குவது எளிது','Your next step, made clear':'உங்கள் அடுத்த படி தெளிவாக உள்ளது','Find':'தேடுங்கள்','care near you':'உங்களுக்கு அருகிலுள்ள சிகிச்சை','the right professional':'சரியான நிபுணர்','Connect':'இணைக்கவும்','your care journey':'உங்கள் சிகிச்சைப் பயணம்','Secure':'பாதுகாப்பான','account access':'கணக்கு அணுகல்','Find trusted doctors, manage appointments, and keep your health details in one place.':'நம்பகமான மருத்துவர்களைக் கண்டறிந்து, சந்திப்புகளை நிர்வகித்து, சுகாதார விவரங்களை ஒரே இடத்தில் வைத்திருங்கள்.','Search verified healthcare professionals and discover options by specialty or city.':'சரிபார்க்கப்பட்ட சுகாதார நிபுணர்களைக் கண்டறிந்து, துறை அல்லது நகரத்தின் அடிப்படையில் தேர்வு செய்யுங்கள்.','Keep your account details and care journey in one simple dashboard.':'உங்கள் கணக்கு விவரங்களையும் சிகிச்சைப் பயணத்தையும் எளிய பலகையில் வைத்திருங்கள்.','Know what to do next, with clear access to the people and services you need.':'உங்களுக்குத் தேவையான நபர்கள் மற்றும் சேவைகளை எளிதாக அணுகி அடுத்து என்ன செய்ய வேண்டும் என்பதை அறியுங்கள்.'
  });
  Object.assign(gujaratiDictionary, {
    'Explore healthcare':'આરોગ્ય સેવાઓ જુઓ','All doctors':'બધા ડૉક્ટરો','Popular:':'લોકપ્રિય:','Choose':'પસંદ કરો','right professional':'યોગ્ય નિષ્ણાત','How it works':'આ કેવી રીતે કાર્ય કરે છે','Browse doctors':'ડૉક્ટરો જુઓ','near you.':'તમારી નજીક.','Search by specialty':'વિશેષતા પ્રમાણે શોધો','Browse by city':'શહેર પ્રમાણે જુઓ','Choose your next step':'તમારું આગળનું પગલું પસંદ કરો','Privacy first':'ગોપનીયતા પ્રથમ','Your records stay yours':'તમારા રેકોર્ડ તમારી પાસે સુરક્ષિત રહે','Easy to get started':'શરૂ કરવું સરળ','Your next step, made clear':'તમારું આગલું પગલું સ્પષ્ટ','Find':'શોધો','care near you':'તમારી નજીકની સંભાળ','the right professional':'યોગ્ય નિષ્ણાત','Connect':'જોડાઓ','your care journey':'તમારી આરોગ્યયાત્રા','Secure':'સુરક્ષિત','account access':'ખાતાની પહોંચ','Find trusted doctors, manage appointments, and keep your health details in one place.':'વિશ્વસનીય ડૉક્ટરો શોધો, મુલાકાતો સંભાળો અને આરોગ્યની વિગતો એક જગ્યાએ રાખો.','Search verified healthcare professionals and discover options by specialty or city.':'ચકાસાયેલા આરોગ્ય નિષ્ણાતોને શોધો અને વિશેષતા અથવા શહેર પ્રમાણે વિકલ્પો જુઓ.','Keep your account details and care journey in one simple dashboard.':'તમારી ખાતાની વિગતો અને આરોગ્યયાત્રા એક સરળ ડેશબોર્ડમાં રાખો.','Know what to do next, with clear access to the people and services you need.':'જરૂરી લોકો અને સેવાઓ સુધી સરળ પહોંચથી આગળ શું કરવું તે જાણો.'
  });
  const commonHomeTamil = {
    'Search doctors or specialties':'மருத்துவர் அல்லது துறையைத் தேடுங்கள்','by specialty':'மருத்துவத் துறைப்படி','by city':'நகரப்படி','your next step':'உங்கள் அடுத்த படி','● Ready':'● தயார்','Care':'சிகிச்சை','connects':'இணைக்கிறது','View doctor':'மருத்துவரைப் பார்க்கவும்','View doctors':'மருத்துவர்களைப் பார்க்கவும்','View professional details':'தொழில்முறை விவரங்களைப் பார்க்கவும்','India':'இந்தியா','Welcome back,':'மீண்டும் வரவேற்கிறோம்,','Choose the next step in your care.':'உங்கள் சிகிச்சையின் அடுத்த படியைத் தேர்ந்தெடுங்கள்.','Browse':'பார்க்கவும்','Specialty:':'மருத்துவத் துறை:','City:':'நகரம்:','HealthConnect Bharat demo profile':'HealthConnect Bharat மாதிரி சுயவிவரம்','Demo preview':'மாதிரி முன்னோட்டம்','Sample':'மாதிரி','Find a verified professional for your care':'உங்கள் சிகிச்சைக்கான சரிபார்க்கப்பட்ட நிபுணரைக் கண்டறியுங்கள்.'
  };
  const commonHomeGujarati = {
    'Search doctors or specialties':'ડૉક્ટર અથવા વિશેષતા શોધો','by specialty':'વિશેષતા પ્રમાણે','by city':'શહેર પ્રમાણે','your next step':'તમારું આગળનું પગલું','● Ready':'● તૈયાર','Care':'સંભાળ','connects':'જોડે છે','View doctor':'ડૉક્ટર જુઓ','View doctors':'ડૉક્ટરો જુઓ','View professional details':'વ્યાવસાયિક વિગતો જુઓ','India':'ભારત','Welcome back,':'ફરી સ્વાગત છે,','Choose the next step in your care.':'તમારી સારવારનું આગળનું પગલું પસંદ કરો.','Browse':'જુઓ','Specialty:':'વિશેષતા:','City:':'શહેર:','HealthConnect Bharat demo profile':'HealthConnect Bharat ડેમો પ્રોફાઇલ','Demo preview':'ડેમો ઝલક','Sample':'નમૂનો','Find a verified professional for your care':'તમારી સારવાર માટે ચકાસાયેલ નિષ્ણાત શોધો.'
  };
  const commonHomeHindi = {
    'Search doctors or specialties':'डॉक्टर या विशेषज्ञता खोजें','by specialty':'विशेषज्ञता से','by city':'शहर से','your next step':'आपका अगला कदम','● Ready':'● तैयार','Care':'देखभाल','connects':'जुड़ती है','View doctor':'डॉक्टर देखें','View doctors':'डॉक्टर देखें','View professional details':'पेशेवर जानकारी देखें','India':'भारत','Welcome back,':'वापस स्वागत है,','Choose the next step in your care.':'अपनी देखभाल में अगला कदम चुनें।','Browse':'देखें','Specialty:':'विशेषज्ञता:','City:':'शहर:','HealthConnect Bharat demo profile':'HealthConnect Bharat डेमो प्रोफ़ाइल','Demo preview':'डेमो पूर्वावलोकन','Sample':'नमूना','Find a verified professional for your care':'अपनी देखभाल के लिए सत्यापित पेशेवर खोजें।'
  };
  Object.assign(tamilDictionary, commonHomeTamil);
  Object.assign(gujaratiDictionary, commonHomeGujarati);
  Object.assign(hindiDictionary, commonHomeHindi);
  Object.assign(tamilDictionary, {
    'Healthcare that feels':'சுகாதாரப் பராமரிப்பு','simple':'எளிமையானது',', human & connected.':' மனிதநேயமும் இணைந்தும் இருக்கிறது.','A clearer path to care':'சிகிச்சைக்கான தெளிவான பாதை'
  });
  Object.assign(gujaratiDictionary, {
    'Healthcare that feels':'આરોગ્યસંભાળ','simple':'સરળ',' , human & connected.':' માનવીય અને જોડાયેલી.',', human & connected.':' માનવીય અને જોડાયેલી.','A clearer path to care':'સારવારનો સરળ માર્ગ'
  });
  const selector = document.querySelector('[data-site-language]');
  const textOriginals = new WeakMap();
  const textLastValues = new WeakMap();
  const attributeOriginals = new WeakMap();
  let activeLanguage = 'en';

  try {
    const savedLanguage = localStorage.getItem('healthconnect-language');
    activeLanguage = ['en', 'hi', 'ta', 'gu'].includes(savedLanguage) ? savedLanguage : 'en';
  } catch {}

  const translateNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const current = node.nodeValue || '';
      let original = textOriginals.get(node);
      if (original === undefined || current !== textLastValues.get(node)) {
        original = current;
        textOriginals.set(node, original);
      }
      const trimmed = original.trim();
      if (!trimmed) return;
      const leading = original.match(/^\s*/)?.[0] || '';
      const trailing = original.match(/\s*$/)?.[0] || '';
      const translated = dictionaries[activeLanguage]?.[trimmed] || trimmed;
      const next = `${leading}${translated}${trailing}`;
      if (current !== next) node.nodeValue = next;
      textLastValues.set(node, next);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.matches('script,style,noscript,[contenteditable="true"]')) return;
    for (const attribute of ['placeholder','title','aria-label','aria-placeholder']) {
      if (!element.hasAttribute(attribute)) continue;
      let originals = attributeOriginals.get(element);
      if (!originals) { originals = new Map(); attributeOriginals.set(element, originals); }
      const current = element.getAttribute(attribute) || '';
      const entry = originals.get(attribute);
      const original = !entry || current !== entry.last ? current : entry.original;
      const translated = dictionaries[activeLanguage]?.[original] || original;
      if (current !== translated) element.setAttribute(attribute, translated);
      originals.set(attribute, { original, last: translated });
    }
    for (const child of element.childNodes) translateNode(child);
  };

  const applyLanguage = (language) => {
    activeLanguage = ['en', 'hi', 'ta', 'gu'].includes(language) ? language : 'en';
    document.documentElement.lang = activeLanguage;
    if (selector) selector.value = activeLanguage;
    try { localStorage.setItem('healthconnect-language', activeLanguage); } catch {}
    translateNode(document.body);
  };

  selector?.addEventListener('change', () => applyLanguage(selector.value));
  applyLanguage(activeLanguage);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateNode(mutation.target);
      else mutation.addedNodes.forEach(translateNode);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();

document.querySelectorAll('[data-doctor-photo-picker]').forEach((picker)=>{
  const preview=picker.querySelector('[data-photo-preview]');
  const menu=picker.querySelector('[data-photo-menu]');
  const toggle=picker.querySelector('[data-photo-menu-toggle]');
  const galleryInput=picker.querySelector('[data-photo-gallery]');
  const dataInput=picker.querySelector('[data-photo-data]');
  const removeInput=picker.querySelector('[data-photo-remove]');
  const errorBox=picker.querySelector('[data-photo-error]');
  const adjustPanel=picker.querySelector('[data-photo-adjust]');
  const zoomInput=picker.querySelector('[data-photo-zoom]');
  const xInput=picker.querySelector('[data-photo-x]');
  const yInput=picker.querySelector('[data-photo-y]');
  const cameraDialog=picker.querySelector('[data-camera-dialog]');
  const cameraVideo=picker.querySelector('[data-camera-video]');
  const cameraStatus=picker.querySelector('[data-camera-status]');
  const captureButton=picker.querySelector('[data-camera-capture]');
  const defaultAvatar=picker.dataset.defaultAvatar||'/doctor-avatar.svg';
  let readId=0;
  let previewObjectUrl=null;
  let currentBitmap=null;
  let cameraStream=null;

  const closeMenu=()=>{menu.hidden=true;toggle.setAttribute('aria-expanded','false');};
  const showError=(message)=>{errorBox.textContent=message;errorBox.hidden=false;};
  const clearError=()=>{errorBox.textContent='';errorBox.hidden=true;};

  const stopCamera=()=>{
    cameraStream?.getTracks().forEach((track)=>track.stop());
    cameraStream=null;
    cameraVideo.srcObject=null;
  };

  const renderCrop=()=>{
    if(!currentBitmap)return;
    const zoom=Number(zoomInput.value)/100;
    const side=Math.min(currentBitmap.width,currentBitmap.height)/zoom;
    const left=(currentBitmap.width-side)*(Number(xInput.value)/100);
    const top=(currentBitmap.height-side)*(Number(yInput.value)/100);
    const canvas=document.createElement('canvas');
    canvas.width=512;
    canvas.height=512;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Photo adjustment is unavailable in this browser.');
    context.drawImage(currentBitmap,left,top,side,side,0,0,512,512);
    const dataUrl=canvas.toDataURL('image/jpeg',0.86);
    if(dataUrl.length>7*1024*1024)throw new Error('Adjusted photo is too large. Please choose a smaller image.');
    preview.src=dataUrl;
    dataInput.value=dataUrl;
    dataInput.dispatchEvent(new Event('input',{bubbles:true}));
    if(removeInput)removeInput.value='';
  };

  const usePhoto=async(file)=>{
    if(!file)return; // Cancelling the picker keeps the current photo.
    const validMime=['image/jpeg','image/jpg','image/png','image/webp'].includes(file.type);
    const validExtension=/\.(jpe?g|png|webp)$/i.test(file.name);
    if(file.size>5*1024*1024){showError('Photo is too large. Choose an image up to 5 MB.');return;}
    if(!validMime&&!validExtension){showError('Use a JPG, JPEG, PNG or WebP image.');return;}

    const thisRead=++readId;
    const previousData=dataInput.value;
    clearError();
    if(previewObjectUrl)URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl=URL.createObjectURL(file);
    preview.src=previewObjectUrl; // Show the chosen photo immediately while its crop is prepared.
    dataInput.value='';
    picker.dataset.photoProcessing='true';
    try{
      const bitmap=await createImageBitmap(file);
      if(thisRead!==readId){bitmap.close();return;}
      currentBitmap?.close();
      currentBitmap=bitmap;
      zoomInput.value='100';
      xInput.value='50';
      yInput.value='50';
      adjustPanel.hidden=false;
      renderCrop();
    }catch(error){
      if(thisRead===readId){
        dataInput.value=previousData;
        preview.src=previousData||picker.dataset.initialPhoto||defaultAvatar;
        showError(error.message||'Could not use that image. Please choose another JPG, PNG or WebP photo.');
      }
    }finally{
      if(thisRead===readId)delete picker.dataset.photoProcessing;
    }
  };

  toggle.addEventListener('click',()=>{
    menu.hidden=!menu.hidden;
    toggle.setAttribute('aria-expanded',String(!menu.hidden));
  });

  picker.querySelector('[data-photo-action="camera"]').addEventListener('click',async()=>{
    closeMenu();
    clearError();
    if(!navigator.mediaDevices?.getUserMedia){
      showError('Camera capture is unavailable in this browser. Use Choose from Gallery, or open the site on localhost/HTTPS with camera access.');
      return;
    }
    try{
      cameraDialog.showModal();
      cameraStatus.textContent='Allow camera access, then position your face in the frame.';
      cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});
      cameraVideo.srcObject=cameraStream;
      await cameraVideo.play();
      captureButton.disabled=false;
    }catch(error){
      stopCamera();
      if(cameraDialog.open)cameraDialog.close();
      const message=error.name==='NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in browser settings, or choose a photo from Gallery.'
        : error.name==='NotFoundError'
          ? 'No camera was found on this device. Choose a photo from Gallery.'
          : 'Could not open the camera. Check that another app is not using it, or choose a photo from Gallery.';
      showError(message);
    }
  });
  picker.querySelector('[data-photo-action="gallery"]').addEventListener('click',()=>{
    closeMenu();
    clearError();
    galleryInput.click();
  });
  picker.querySelector('[data-photo-action="remove"]')?.addEventListener('click',()=>{
    closeMenu();
    clearError();
    readId+=1;
    currentBitmap?.close();currentBitmap=null;
    if(previewObjectUrl){URL.revokeObjectURL(previewObjectUrl);previewObjectUrl=null;}
    preview.src=defaultAvatar;
    dataInput.value='';
    adjustPanel.hidden=true;
    galleryInput.value='';
    if(removeInput)removeInput.value=picker.closest('form')?.action.includes('/profile/photo')?'1':'';
    if(removeInput?.value==='1')picker.closest('form')?.requestSubmit();
  });
  galleryInput.addEventListener('change',()=>usePhoto(galleryInput.files?.[0]));
  [zoomInput,xInput,yInput].forEach((input)=>input.addEventListener('input',()=>{
    if(!currentBitmap)return;
    try{renderCrop();clearError();}
    catch(error){showError(error.message);}
  }));
  captureButton.addEventListener('click',async()=>{
    if(!cameraVideo.videoWidth||!cameraVideo.videoHeight){showError('Camera is still starting. Please wait a moment.');return;}
    const canvas=document.createElement('canvas');
    const scale=Math.min(1,1600/Math.max(cameraVideo.videoWidth,cameraVideo.videoHeight));
    canvas.width=Math.round(cameraVideo.videoWidth*scale);
    canvas.height=Math.round(cameraVideo.videoHeight*scale);
    canvas.getContext('2d')?.drawImage(cameraVideo,0,0,canvas.width,canvas.height);
    const blob=await new Promise((resolve)=>canvas.toBlob(resolve,'image/jpeg',0.88));
    if(!blob){showError('Could not capture the photo. Please try again.');return;}
    stopCamera();
    cameraDialog.close();
    await usePhoto(new File([blob],`doctor-photo-${Date.now()}.jpg`,{type:'image/jpeg'}));
  });
  picker.querySelector('[data-camera-cancel]').addEventListener('click',()=>cameraDialog.close());
  cameraDialog.addEventListener('close',stopCamera);
  picker.closest('form')?.addEventListener('submit',(event)=>{
    if(picker.dataset.photoProcessing==='true'){
      event.preventDefault();
      showError('Please wait for the selected photo to finish loading.');
    }else if(currentBitmap&&!dataInput.value){
      event.preventDefault();
      showError('The adjusted photo is not ready yet. Please try again.');
    }
  });
  document.addEventListener('click',(event)=>{if(!picker.contains(event.target))closeMenu();});
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape')closeMenu();});
});

document.querySelectorAll('form[data-utc-datetime]').forEach(form=>form.addEventListener('submit',()=>{form.querySelectorAll('input[type="datetime-local"]').forEach(input=>{if(input.value){const date=new Date(input.value);input.value=date.toISOString().slice(0,16)}})}));
document.querySelectorAll('form[data-private-upload]').forEach(form=>{
  const fileInput=form.querySelector('[data-private-file]');
  const dataInput=form.querySelector('[data-private-file-data]');
  const nameInput=form.querySelector('[data-private-file-name]');
  const fileNameLabel=form.querySelector('[data-contact-file-name]');
  if(!fileInput||!dataInput)return;
  let reading=false;
  fileInput.addEventListener('change',()=>{
    const file=fileInput.files?.[0];
    dataInput.value='';
    if(nameInput)nameInput.value='';
    if(fileNameLabel)fileNameLabel.textContent=file?.name||'No file selected';
    if(!file)return;
    const supported=['application/pdf','image/jpeg','image/png','image/webp'];
    if(!supported.includes(file.type)||file.size>5*1024*1024){fileInput.value='';if(fileNameLabel)fileNameLabel.textContent='No file selected';window.alert('Choose a PDF, JPG, PNG or WebP file up to 5 MB.');return;}
    if(nameInput)nameInput.value=file.name;
    reading=true;
    const reader=new FileReader();
    reader.onload=()=>{dataInput.value=typeof reader.result==='string'?reader.result:'';reading=false;};
    reader.onerror=()=>{reading=false;fileInput.value='';dataInput.value='';if(nameInput)nameInput.value='';if(fileNameLabel)fileNameLabel.textContent='No file selected';window.alert('The document could not be read. Please choose it again.');};
    reader.readAsDataURL(file);
  });
  form.addEventListener('submit',event=>{if(reading||(fileInput.files?.length&&!dataInput.value)){event.preventDefault();window.alert('Wait for the document to finish loading, then save again.');}});
});
document.querySelectorAll('[data-appointment-filter]').forEach((button)=>button.addEventListener('click',()=>{
  const filter=button.dataset.appointmentFilter;
  document.querySelectorAll('[data-appointment-filter]').forEach((item)=>item.classList.toggle('active',item===button));
  document.querySelectorAll('[data-doctor-appointment]').forEach((card)=>{
    const matches=filter==='all'
      || card.dataset.status===filter
      || (filter==='closed'&&['CANCELLED','REJECTED','NO_SHOW'].includes(card.dataset.status))
      || (filter==='today'&&card.dataset.isToday==='true')
      || (filter==='upcoming'&&card.dataset.isUpcoming==='true');
    card.hidden=!matches;
  });
}));
document.querySelectorAll('[data-calendar-filter]').forEach(button=>button.addEventListener('click',()=>{
  const mode=button.dataset.calendarFilter;
  const dateInput=document.querySelector('[data-calendar-date]');
  const today=dateInput?.value?new Date(`${dateInput.value}T00:00:00`):new Date();today.setHours(0,0,0,0);
  const limit=new Date(today);limit.setDate(limit.getDate()+(mode==='week'?7:mode==='day'?1:30));
  document.querySelectorAll('[data-calendar-filter]').forEach(item=>item.classList.toggle('active',item===button));
  document.querySelectorAll('[data-calendar-slot]').forEach(card=>{const date=new Date(`${card.dataset.slotDate}T00:00:00`);card.hidden=date<today||date>=limit;});
}));
document.querySelector('[data-calendar-date]')?.addEventListener('change',()=>document.querySelector('[data-calendar-filter].active')?.click());
document.querySelectorAll('[data-patient-search]').forEach(input=>input.addEventListener('input',()=>{
  const query=input.value.trim().toLocaleLowerCase();
  document.querySelectorAll('[data-doctor-patient]').forEach(card=>{card.hidden=!card.dataset.patientName.includes(query);});
}));
document.querySelectorAll('[data-medicine-list]').forEach(form=>{
  const rows=form.querySelector('[data-medicine-rows]');
  const template=form.querySelector('[data-medicine-template]');
  form.querySelector('[data-add-medicine]')?.addEventListener('click',()=>rows.append(template.content.cloneNode(true)));
  rows.addEventListener('click',event=>{if(event.target.closest('[data-remove-medicine]'))event.target.closest('.medicine-entry')?.remove();});
});
document.querySelectorAll('form[data-confirm]').forEach(form=>form.addEventListener('submit',event=>{if(!window.confirm(form.dataset.confirm))event.preventDefault()}));
document.querySelectorAll('[data-print]').forEach(button=>button.addEventListener('click',()=>window.print()));
