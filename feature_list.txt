Ignore the features marked with "##",
features marked with "$$" are already implemented, you can use it for your knowledge

$$ 1. on the web app, following the scene detection process at Practice mode
    a. scene detection is based on Acceleration overthreshold or ToF SR and range overthreshold. Device TO is recorded as the MPU timestamp (acceleration overthreshold) or ToF timestamp, refer to triage_models.py
    b. Based on the host timestamp, which is recorded as the host time when the packets is received, and the host time when the video is started, the video clip moment when the event detected is recorded
    c. run MPU data and ToF data in the event window with the shot classifier, and get the AI prediction, refer to triage_scene.py
    d. Use the classifier output to update the score, and announce the results in Audio 

$$ 2. refine the json file fields, apply to both python GUI and web app, and make them consistent
                'ai_top': 'top' as before
                'ai_subtype': 'subtype' as before
                'user_top': user input for top class, default = 'ai_top', until user change it
                'user_subtype': user input for subtype class, default = 'ai_subtype', until user change it
                'row_idx': 'row_inx' as before
                'event_ts_s': 'event_ts_s' as before from ESP32 device
                'event_type': 'event_type as before, either "impact" or "basket"
                'host_ts_udp': 'host_ts_udp' as before, from host
                'video_clip_ts': time stamp in the video clip when the event is detected, host_ts_udp - host_st_video_start_ts, the whole clip spans from video_clip_ts - event_pre_ms to video_clip_ts + event_post_ms

    top classes: "Miss", "Made", "Not-a-shot"
    subtype for "Made": "Swish", "Rim-in" (used to be Bank, replace it with Rim-in), "Unsure"
$$ 3. during review session
    a. for each scene, automatically play the video clip from video_clip_ts - event_pre_ms to video_clip_ts + event_post_ms, repeatedly
    b. audio announce the AI classificaiton results top, and subtype for 'Made'
    c. add a Go back button, to move to the previous scene if clicked. Don't put go forward button or skip button, the user has to go through and confirm all scenes to submit the results
$$ 4. on the web app add a version number on the dashboard page of the web app on the bottom with small print, so that I know the current version, starting with version 0.1
$$ 5. after review, did you upload the video clips or the entire video (with compression to save storage space) to the firebase storage if the upload video clips is enabled on the web app?
$$ 6. change the top class "Made" to "Make", to make it better align to common phrase. During shot review, put the top classes "Make", "Miss", "Not-a-shot" on the top, right next to the video window. The subtype ("Swish", "Rim-in" "Unsure") below the top classes is only active for a "Make", and grey out for other top classes
$$ 7. double check the firmware update page. I put the firmware on the same github repo, fw/firmware.bin. I will need to test it.
$$ 8. during practice session, in addition to "Makde" or "Miss", I need the audio to also speak out the score, MADE out of TOTAL, such as 8 out of 12. 
$$ 9. The full video is not uploaded when I enable the video upload toggle button. The video doesn't show up on Firebase storage. you need to double check. Also set the default video upload button to disabled.
$$ 10. During review session, when I click the class (top class or subclass) to correct the label, the audio it played was still the AI labels. It should say "Correction" + the class user picked. example "Correction, Miss" or "Correction, Swish"
$$ 11. On the Practice page, add a Restart button under Stop Practice, to restart the practice, such as clear the score, re-calculate the baseline, etc, similar to the Start Practice button. make sure the whole page fit in the screen (Portrait)
$$ 12. After review session is finished, generate a practice summary json file contain the summary of this practice, including the following. This file should be uploaded to firebase storage.
    a. practice start date & time
    b. practice duration, in minutes
    c. AI score, score recored by AI, makes/total, the total should exclude "Not-a-shot"
    d. AI percentage, percentage of makes out of total
    e. user score, score corrected by user, makes/total, the total should exclude "Not-a-shot"
    f. user percentage, percentage of makes out of total
$$ 13. on the review history page. the web app read the history practice summary json files from the firebase. and show the summary of the most recent 10 practices in a table fasion, starting with the most recent one. At the end, add
    a. total practice time, in minutes
    b. total AI score
    b. total AI percentage
    c. total user score
    d. total user percentage
$$ 14. on the review history page, for the life time stats, use AI score, other than user score. This is to motivate beta users to do good labeling jobs. 
$$ 15. on the label review page, when user select Make, put Rim-in as the default subtype class, other than null. 

$$ 16. on label review page, add a comment field, so that user can input comments for certain scene
    a. comment is Optional
    b. comment text is limited to 70 characters
    c. add comment field into session_labels.json
## 17. the program is using the classifier as the event detector. eventually I will add a separate event detector, and only use classifier to do shot classification
    a. decouple event detector and shot classifier, with separate parameters. To DO
    b. basket time should be the rising edge of ToF event, not falling edge, I corrected it manually -> basket_time: this.stateStartTime, // time recorded at BASKET_DETECTED entry
18. Make the web  app-version configuration parameters that I can update every time I make changes. The current version is V0.2. 
19. Remove the function to generate and upload .csv, instead, save the received raw device packets (containing TOF and MPU data, and other meta data) to .bin and upload the .bin to firebase storage, to save the storage space.
20. Modify Shots data format, in the following format
    userId,
    sessionId, 
    createdAt, 
    timestamp, (rename to utc_timestamp)
    ai_prediction, (rename to ai_top)
    ai_subtype,
    basket_type, (remove)
    confidence,
    user_top,
    user_subtype, 
    user_label, (remove)
    comment, (add, the same as session_labels.json)
    source, (add, the same as session_labels.json)
    event_type, (add, the same as session_labels.json)
    device_event_ts, (add, event_ts_s as session_labels.json)
    host_event_ts,
    video_clip_ts,

21. Modify session_labels.json format, in the following format
      "1": {
    "ai_top": "Miss",
    "ai_subtype": null,
    "user_top": "Miss",
    "user_subtype": null,
    "comment": "",
    "source": "auto",
    "event_type": "impact",
    "row_idx": 1, (remove)
    "event_ts_s": 72.768, (rename to device_event_ts)
    "host_ts_udp": 107.21379999999702, (remove)
    "video_clip_ts": 33.89
  },

## 21. change the firmware update button to Device Config. It includes
    a. device information: HW version, SW version, Device S/N, Battery, Temperature
    b. baseline calculation results, and trouble shooting guide
    c. classifier setting, Optional
    d. firmware upgrade.

## 20. thinking of only uploading video clips other than the whole video.
## 21. move the firmware updates to a firmware release process.
## 9. make video upload enable toggle button at the review page, after review is completed, have an upload page, select all the clips, clips with correction, no clips
