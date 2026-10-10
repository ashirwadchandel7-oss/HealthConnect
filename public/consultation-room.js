(() => {
  const root=document.querySelector('[data-consultation]');
  if(!root)return;
  const by=(selector)=>document.querySelector(selector);
  const status=by('[data-call-status]'),duration=by('[data-call-duration]'),estimate=by('[data-call-estimate]');
  const join=by('[data-join-call]'),mic=by('[data-toggle-mic]'),camera=by('[data-toggle-camera]');
  const enableAudio=by('[data-enable-audio]');
  const countdown=by('[data-appointment-countdown]');
  const post=async(path)=>{
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:root.dataset.csrf}),credentials:'same-origin'});
    const json=await response.json().catch(()=>({}));if(!response.ok)throw new Error(json.error||'Consultation request failed.');return json;
  };
  let room=null,startedAt=0,localVideo=null;
  const refreshAppointmentState=async()=>{
    if(root.dataset.status!=='ACCEPTED'||!join||!countdown)return;
    try{
      const response=await fetch(`/consultations/${root.dataset.consultation}/state`,{credentials:'same-origin'});
      if(!response.ok){
        if(response.status===401||response.status===403)throw new Error('Your sign-in expired. Sign in again, then reopen this consultation.');
        throw new Error(`Appointment status could not be checked (HTTP ${response.status}). Reload this page and try again.`);
      }
      const state=await response.json();
      join.disabled=!state.canJoin;
      if(!state.scheduledAt&&state.status==='ACCEPTED'){
        countdown.textContent='The doctor has not set an appointment time yet. Ask them to reopen the request and schedule it.';
        status.textContent='Waiting for the doctor to set the exact call time.';
        return;
      }
      if(state.canJoin){countdown.textContent='Your appointment is open. Join now; the doctor or patient can connect from this page.';status.textContent=state.patientWaiting&&root.dataset.role==='doctor'?'The patient has joined and is waiting. Join the call now.':'Appointment is open. Join the secure video call when ready.';}
      else if(state.scheduledAt){
        const start=new Date(state.scheduledAt).getTime();
        const openAt=start-15*60*1000;
        const remaining=Math.max(0,openAt-Date.now());
        if(remaining===0){
          countdown.textContent='The call window is open. If the button is still disabled, reload this page.';
        }else{
          const minutes=Math.ceil(remaining/60000);
          countdown.textContent=`The call button activates 15 minutes before your appointment (about ${minutes} minute${minutes===1?'':'s'} from now).`;
        }
      }
    }catch(error){
      countdown.textContent=error.message||'Could not check call availability. Reload this page and try again.';
      status.textContent=error.message||'Could not check call availability. Reload this page and try again.';
    }
  };
  refreshAppointmentState();
  if(root.dataset.status==='ACCEPTED')setInterval(refreshAppointmentState,5000);
  const updateClock=()=>{if(!startedAt)return;const seconds=Math.floor((Date.now()-startedAt)/1000);duration.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;estimate.textContent=`₹${((seconds*Number(root.dataset.rate||0))/60).toFixed(2)}`;};
  join.addEventListener('click',async()=>{
    join.disabled=true;status.textContent='Requesting private room access…';
    try{
      if(!window.LivekitClient)throw new Error('Video SDK did not load. Reload the page.');
      const auth=await post(`/consultations/${root.dataset.consultation}/token`);
      room=new window.LivekitClient.Room({adaptiveStream:true,dynacast:true,rtcConfig:auth.rtcConfig});
      room.on(window.LivekitClient.RoomEvent.TrackSubscribed,(track)=>{
        if(track.kind==='video'){
          const element=by('[data-remote-video]')||document.createElement('video');
          element.autoplay=true;element.playsInline=true;element.dataset.remoteVideo='';
          if(!element.isConnected)by('.video-grid').prepend(element);
          track.attach(element);
        }else if(track.kind==='audio'){
          const element=document.createElement('audio');
          element.autoplay=true;element.playsInline=true;element.dataset.remoteAudio='';element.style.display='none';
          by('.video-grid').append(element);track.attach(element);
          element.play().catch(()=>{status.textContent='Call connected. Tap the page once to enable the other participant’s audio.';});
        }
      });
      room.on(window.LivekitClient.RoomEvent.TrackUnsubscribed,(track)=>track.detach().forEach(el=>{
        if(el.dataset.remoteAudio!==undefined)el.remove();
        else if(el.dataset.remoteVideo!==undefined)el.srcObject=null;
      }));
      room.on(window.LivekitClient.RoomEvent.TrackSubscriptionFailed,(_sid,participant)=>{
        status.textContent=`Connected to ${participant.name||'the other participant'}, but media subscription failed. Rejoin the call.`;
      });
      room.on(window.LivekitClient.RoomEvent.Disconnected,()=>{status.textContent='Connection ended. Reopen the consultation page to reconnect.';join.disabled=false;});
      room.on(window.LivekitClient.RoomEvent.Reconnecting,()=>status.textContent='Connection interrupted. Reconnecting…');
      room.on(window.LivekitClient.RoomEvent.Reconnected,()=>status.textContent='Reconnected securely.');
      room.on(window.LivekitClient.RoomEvent.AudioPlaybackStatusChanged,()=>{
        if(!room.canPlaybackAudio){enableAudio.hidden=false;status.textContent='Call connected. Select Enable call audio to hear the other participant.';}
        else enableAudio.hidden=true;
      });
      await room.connect(auth.serverUrl,auth.token,{autoSubscribe:true,rtcConfig:auth.rtcConfig});
      await room.localParticipant.enableCameraAndMicrophone();
      localVideo=room.localParticipant.videoTrackPublications.values().next().value?.videoTrack;
      if(localVideo)localVideo.attach(by('[data-local-video]'));
      await post(`/consultations/${root.dataset.consultation}/joined`);
      let endedFromServer=false;
      const updateServerState=async()=>{
        if(endedFromServer)return;
        const response=await fetch(`/consultations/${root.dataset.consultation}/state`,{credentials:'same-origin'});if(!response.ok)return;const state=await response.json();
        if(state.startedAt&&!startedAt){startedAt=new Date(state.startedAt).getTime();setInterval(updateClock,1000);updateClock();status.textContent='Connected. Billing duration is tracked by the server.';}
        else if(!state.startedAt)status.textContent='You are connected. Waiting for the other participant; billing begins when both are connected.';
        if(['SETTLING','COMPLETED','FAILED','CANCELLED'].includes(state.status)){
          endedFromServer=true;
          if(room)room.disconnect();
          status.textContent=state.status==='SETTLING'?'Call ended. Preparing the server-calculated demo payment…':`Call ${state.status.toLowerCase()}. Refreshing the consultation summary…`;
          window.setTimeout(()=>location.reload(),state.status==='SETTLING'?1200:2200);
        }
      };
      await updateServerState();setInterval(updateServerState,2500);
      mic.disabled=false;camera.disabled=false;join.hidden=true;
    }catch(error){status.textContent=error.message||'Camera/microphone/video connection failed. Check permission and internet.';join.disabled=false;if(room)room.disconnect();}
  });
  enableAudio.addEventListener('click',async()=>{
    if(!room)return;
    try{await room.startAudio();enableAudio.hidden=true;status.textContent='Call audio enabled.';}
    catch{status.textContent='Could not enable call audio. Check the device volume and browser permissions.';}
  });
  mic.addEventListener('click',async()=>{if(!room)return;const enabled=room.localParticipant.isMicrophoneEnabled;await room.localParticipant.setMicrophoneEnabled(!enabled);mic.textContent=enabled?'Unmute microphone':'Mute microphone';});
  camera.addEventListener('click',async()=>{if(!room)return;const enabled=room.localParticipant.isCameraEnabled;await room.localParticipant.setCameraEnabled(!enabled);camera.textContent=enabled?'Turn camera on':'Turn camera off';});
  by('[data-end-consultation]')?.addEventListener('submit',event=>{if(!window.confirm('End the consultation? The server will calculate the duration and settle payment.'))event.preventDefault();});
  window.addEventListener('beforeunload',()=>{if(room)room.disconnect();});
})();
