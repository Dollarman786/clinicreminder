/* ClinicReminder embed SDK */
(function(){
  const CR={apiUrl:'',apiKey:''};
  window.ClinicReminder={
    configure(opts){CR.apiUrl=(opts.apiUrl||'').replace(/\/$/,'');CR.apiKey=opts.apiKey||'';},
    async createAppointment(data){if(!CR.apiUrl||!CR.apiKey) throw new Error('ClinicReminder is not configured'); const r=await fetch(`${CR.apiUrl}/functions/v1/create-appointment`,{method:'POST',headers:{'Content-Type':'application/json','x-clinic-api-key':CR.apiKey},body:JSON.stringify(data)}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'Appointment could not be created'); return j;}
  };
})();
