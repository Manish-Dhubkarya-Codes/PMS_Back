var express = require('express');
var router = express.Router();
var pool = require("./pool")
// var upload = require("./multer");

router.post('/submit_client_inquiry', function (req, res, next) {
    console.log("REQQQQQQQQQQQQQQQQQ",req.body)
    try {
        pool.query("insert into client_inquiry (inquiryType, firstName, lastName, email, phone, howToHelp) values(?,?,?,?,?,?)", [req.body.inquiryType, req.body.firstName, req.body.lastName, req.body.email, req.body.phone, req.body.howToHelp], function (error, result) {            
            if (error) {
                console.log("ERRRRRRRRR",error)
               return res.status(400).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
               return res.status(200).json({ status: true, message: "Cilent Inquiry Submitted Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});

module.exports=router;