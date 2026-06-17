var express = require('express');
var router = express.Router();
var pool = require("./pool")
// var upload = require("./multer");

router.post('/submit_conference', function (req, res, next) {
    // console.log("REQQQQQQQQQQQQQQQQQ",req)
    try {
        pool.query("insert into conferences (publisher, conferenceName, area, subject, lastDOfSub, registrationCharges, links) values(?,?,?,?,?,?,?)", [req.body.publisher, req.body.conferenceName, req.body.area, req.body.subject, req.body.lastDOfSub, req.body.registrationCharges, req.body.links], function (error, result) {            
            if (error) {
                console.log("ERRRRRRRRR",error)
               return res.status(400).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
               return res.status(200).json({ status: true, message: "Conference Submitted Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});
router.post('/update_conference', function (req, res, next) {
    console.log(req.body)
    console.log(req.file)
    try {
        pool.query("update conferences set publisher=?, conferenceName=?, area=?, subject=?, lastDOfSub=?, registrationCharges=?, links=? where conferenceId=?", [req.body.publisher, req.body.conferenceName, req.body.area, req.body.subject, req.body.lastDOfSub, req.body.registrationCharges, req.body.links, req.body.conferenceId], function (error, result) {
            if (error) {
                console.log(error)
               return res.status(500).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
               return res.status(200).json({ status: true, message: "Category Updated Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});

router.post('/delete_conference', function (req, res, next) {
    console.log(req.body)
    console.log(req.file)
    try {
        pool.query("delete from conferences where conferenceId=?", [req.body.conferenceId], function (error, result) {
            if (error) {
                console.log(error)
               return res.status(400).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
               return res.status(200).json({ status: true, message: "Category Deleted Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});
router.get("/display_all_conferences", function(req, res, next){
    
    try {
        pool.query("select * from conferences", function (error, result) {
            if (error) {
                console.log(error)
               return res.status(400).json({status: false, message: "DataBase Error, Plz Contact DataBase Admin"})
            }
            else {
               return res.status(200).json({data:result, status: true, message: "Success!" })
            }
            
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })
    }
})
module.exports = router;